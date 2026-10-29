// Beebeeb preview-matrix fixture — Java (task 1565).
public class Sample {
    static final String GREETING = "café naïve 日本語 Ελληνικά Москва €19.99";

    public static void main(String[] args) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 20; i++) {
            sb.append("0123456789 ");
        }
        sb.append("end-of-long-line");
        System.out.println(GREETING);
        System.out.println(sb.toString());
    }
}
