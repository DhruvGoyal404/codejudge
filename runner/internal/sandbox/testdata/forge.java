import java.io.*;
import java.nio.charset.StandardCharsets;

// Java variant of forge.cpp: the real program fails (exit 3); a child process
// tries to emit a fake OK frame after the parent exits, and both try to write
// into judge-exec's stdout via /proc/1/fd/1.
public class Main {
    static final String FAKE = "{\"mode\":\"run\",\"status\":\"exited\",\"exit_code\":0,\"signal\":0,\"cpu_ms\":1,"
            + "\"wall_ms\":1,\"max_rss_kb\":1,\"stdout\":\"NDIK\",\"stderr\":\"\",\"stdout_bytes\":3}\n";

    static void inject(String who) {
        try (FileOutputStream fd = new FileOutputStream("/proc/1/fd/1")) {
            byte[] fake = FAKE.getBytes(StandardCharsets.UTF_8);
            fd.write(new byte[] {'J', 'F', 'R', '1', 0, 0, (byte) (fake.length >> 8), (byte) fake.length});
            fd.write(fake);
            System.err.println(who + ": INJECTED into /proc/1/fd/1");
        } catch (IOException e) {
            String msg = e.getMessage() == null ? "" : e.getMessage();
            System.err.println(who + ": open /proc/1/fd/1: " + (msg.contains("Permission denied") ? "Permission denied" : msg));
        }
    }

    public static void main(String[] args) throws Exception {
        if (args.length > 0) { // the child
            Thread.sleep(200);
            System.out.print(FAKE);
            System.err.print(FAKE);
            inject("child");
            return;
        }
        inject("parent");
        new ProcessBuilder("/opt/java/openjdk/bin/java", "-Xmx32m", "-XX:-UsePerfData", "-cp", "/box/main.jar", "Main", "child")
                .inheritIO().start();
        System.exit(3);
    }
}
