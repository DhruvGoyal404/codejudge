public class Main {
    public static void main(String[] args) {
        long x = 0;
        while (true) x += System.nanoTime() & 1;
    }
}
