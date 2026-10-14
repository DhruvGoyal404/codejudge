// 8 threads sum disjoint ranges (multithreading works in the sandbox).
public class Main {
    public static void main(String[] args) throws InterruptedException {
        final int T = 8;
        long[] part = new long[T];
        Thread[] ts = new Thread[T];
        for (int t = 0; t < T; t++) {
            final int id = t;
            ts[t] = new Thread(() -> { for (long i = id; i < 1_000_000; i += T) part[id] += i; });
            ts[t].start();
        }
        long sum = 0;
        for (int t = 0; t < T; t++) { ts[t].join(); sum += part[t]; }
        System.out.println("threads=" + T + " sum=" + sum);
    }
}
