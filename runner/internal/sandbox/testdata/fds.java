import java.nio.file.*;
import java.util.*;

// Java variant of fds.cpp: list this process's descriptors.
public class Main {
    public static void main(String[] args) throws Exception {
        List<Integer> fds = new ArrayList<>();
        try (DirectoryStream<Path> ds = Files.newDirectoryStream(Path.of("/proc/self/fd"))) {
            for (Path p : ds) fds.add(Integer.parseInt(p.getFileName().toString()));
        }
        Collections.sort(fds);
        for (int fd : fds) {
            try { System.out.println("fd " + fd + " -> " + Files.readSymbolicLink(Path.of("/proc/self/fd/" + fd))); }
            catch (Exception e) { /* closed meanwhile */ }
        }
    }
}
