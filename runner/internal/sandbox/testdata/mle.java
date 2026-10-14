import java.util.*;

// Keeps allocating filled 1 MiB arrays: the heap limit (-Xmx = memory limit)
// is hit -> java.lang.OutOfMemoryError -> MLE.
public class Main {
    public static void main(String[] args) {
        List<byte[]> blocks = new ArrayList<>();
        while (true) {
            byte[] b = new byte[1 << 20];
            Arrays.fill(b, (byte) 1);
            blocks.add(b);
        }
    }
}
