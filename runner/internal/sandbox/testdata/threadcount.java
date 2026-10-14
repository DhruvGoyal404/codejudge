import java.nio.file.*;

// Reports the JVM's thread count after start-up (calibrates ExtraTasks).
public class Main {
    public static void main(String[] args) throws Exception {
        for (String l : Files.readAllLines(Path.of("/proc/self/status")))
            if (l.startsWith("Threads:")) System.out.println(l.substring("Threads:".length()).trim());
    }
}
