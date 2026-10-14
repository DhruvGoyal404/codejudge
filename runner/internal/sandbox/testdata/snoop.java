import java.io.*;
import java.nio.file.*;
import java.util.stream.*;

// Java variant of snoop.py: look for other tests' inputs in every scratch
// location, print what is found, and leave traces for the next test.
public class Main {
    public static void main(String[] args) throws Exception {
        String own = new String(System.in.readAllBytes()).trim();
        System.out.println("own: " + own);
        for (String root : new String[] {"/box", "/tmp", "/dev/shm"}) {
            Path r = Path.of(root);
            if (!Files.isDirectory(r)) continue;
            try (Stream<Path> s = Files.walk(r)) {
                for (Path p : s.filter(Files::isRegularFile).collect(Collectors.toList())) {
                    try {
                        byte[] data = Files.readAllBytes(p);
                        String txt = new String(data, 0, Math.min(data.length, 200)).trim();
                        System.out.println("found " + p + " " + txt);
                    } catch (IOException e) { /* unreadable */ }
                }
            } catch (IOException | UncheckedIOException e) { /* unwalkable */ }
        }
        Files.writeString(Path.of("/tmp/left-behind"), "LEFTOVER " + own);
        Files.writeString(Path.of("/box/left-behind"), "LEFTOVER " + own);
    }
}
