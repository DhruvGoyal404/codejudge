import java.io.*;
import java.util.*;

public class Main {
    public static void main(String[] args) throws IOException {
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in));
        StringTokenizer st = new StringTokenizer(in.readLine());
        long a = Long.parseLong(st.nextToken()), b = Long.parseLong(st.nextToken());
        System.out.println(a + b);
    }
}
