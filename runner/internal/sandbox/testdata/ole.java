import java.io.*;

public class Main {
    public static void main(String[] args) {
        PrintWriter out = new PrintWriter(new BufferedWriter(new OutputStreamWriter(System.out)));
        String line = "0123456789012345678901234567890123456789012345678901234567890123";
        while (true) out.println(line);
    }
}
