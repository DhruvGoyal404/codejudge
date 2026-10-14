// Deep recursion (depth 200000) must work: the main thread gets -Xss.
public class Main {
    static long depth(int n) { return n == 0 ? 0 : 1 + depth(n - 1); }
    public static void main(String[] args) {
        System.out.println(depth(200_000));
    }
}
