//go:build integration

// Requires the compose Postgres with migrations applied and seed problems
// imported. CODEJUDGE_DATABASE_URL must be set.
//
//	go test -p 1 -tags integration -count=1 -v ./internal/store/
package store

import (
	"context"
	"testing"
)

// A stale worker (superseded by a reclaim) must not be able to write a
// result, whether it finishes before or after the newer attempt.
func TestFencedWrites(t *testing.T) {
	ctx := context.Background()
	url, err := DatabaseURL()
	if err != nil {
		t.Skip(err)
	}
	pool, err := Connect(ctx, url, 2)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()

	newSub := func() string {
		var id string
		if err := pool.QueryRow(ctx, `INSERT INTO submissions (problem_id, language, source)
			SELECT id, 'cpp', 'int main(){}' FROM problems WHERE slug = 'ledger-total' RETURNING id::text`).Scan(&id); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM submissions WHERE id = $1`, id) })
		return id
	}
	claim := func(id, w string) int {
		a, ok, err := Claim(ctx, pool, id, w)
		if err != nil || !ok {
			t.Fatalf("claim by %s: ok=%v err=%v", w, ok, err)
		}
		return a
	}
	state := func(id string) (verdict string, attempt int, worker string, tests int) {
		if err := pool.QueryRow(ctx, `SELECT coalesce(verdict,''), attempt, coalesce(worker_id,''),
			(SELECT count(*) FROM submission_tests WHERE submission_id = $1) FROM submissions WHERE id = $1`, id).
			Scan(&verdict, &attempt, &worker, &tests); err != nil {
			t.Fatal(err)
		}
		return
	}
	acResult := Final{Verdict: "AC", Tests: []TestRow{{Seq: 1, Name: "01", IsSample: true, Status: "AC"}, {Seq: 2, Name: "02", IsSample: true, Status: "AC"}}}
	waResult := Final{Verdict: "WA", FailedTest: "01", FailedIsSample: true, Tests: []TestRow{{Seq: 1, Name: "01", IsSample: true, Status: "WA"}}}

	t.Run("stale finishes after newer attempt", func(t *testing.T) {
		id := newSub()
		stale := claim(id, "worker-a")
		fresh := claim(id, "worker-b") // reclaim after A was presumed dead
		if ok, err := FinishFenced(ctx, pool, id, fresh, acResult); err != nil || !ok {
			t.Fatalf("current attempt rejected: %v %v", ok, err)
		}
		if ok, err := FinishFenced(ctx, pool, id, stale, waResult); err != nil || ok {
			t.Fatalf("stale write accepted: ok=%v err=%v", ok, err)
		}
		if v, a, w, n := state(id); v != "AC" || a != 2 || w != "worker-b" || n != 2 {
			t.Fatalf("state after stale write: verdict=%s attempt=%d worker=%s tests=%d", v, a, w, n)
		}
	})

	t.Run("stale finishes before newer attempt", func(t *testing.T) {
		id := newSub()
		stale := claim(id, "worker-a")
		fresh := claim(id, "worker-b")
		if ok, err := FinishFenced(ctx, pool, id, stale, waResult); err != nil || ok {
			t.Fatalf("stale write accepted while newer attempt running: ok=%v err=%v", ok, err)
		}
		if v, _, _, n := state(id); v != "" || n != 0 {
			t.Fatalf("stale write leaked: verdict=%q tests=%d", v, n)
		}
		if ok, err := FinishFenced(ctx, pool, id, fresh, acResult); err != nil || !ok {
			t.Fatalf("current attempt rejected: %v %v", ok, err)
		}
	})

	t.Run("no double finish, no re-claim after done", func(t *testing.T) {
		id := newSub()
		a := claim(id, "worker-a")
		if ok, _ := FinishFenced(ctx, pool, id, a, acResult); !ok {
			t.Fatal("finish rejected")
		}
		if ok, _ := FinishFenced(ctx, pool, id, a, waResult); ok {
			t.Fatal("second finish with the same attempt accepted")
		}
		if _, ok, err := Claim(ctx, pool, id, "worker-c"); err != nil || ok {
			t.Fatalf("done submission re-claimed: ok=%v err=%v", ok, err)
		}
	})
}
