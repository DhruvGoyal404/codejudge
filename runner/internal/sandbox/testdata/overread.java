import java.io.*;

// Java variant of overread.cpp: read stdin to EOF, then keep trying for 1 s;
// nothing beyond this test's own input may ever arrive.
public class Main {
    public static void main(String[] args) throws Exception {
        InputStream in = System.in;
        ByteArrayOutputStream own = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        int n;
        while ((n = in.read(buf)) > 0) own.write(buf, 0, n);
        ByteArrayOutputStream extra = new ByteArrayOutputStream();
        for (int i = 0; i < 20; i++) {
            Thread.sleep(50);
            while ((n = in.read(buf)) > 0) extra.write(buf, 0, n);
        }
        System.out.println("own=" + own.toString() + " extra=" + extra.size() + " extradata=" + extra.toString());
    }
}
