public class Main {
    public static void main(String[] args) {
        System.out.println("before");
        throw new IllegalStateException("boom");
    }
}
