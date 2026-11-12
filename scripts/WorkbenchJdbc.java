import java.io.*;
import java.nio.charset.StandardCharsets;
import java.sql.*;
import java.util.Base64;
import java.util.Properties;

public final class WorkbenchJdbc {
    private static String decode(String value) {
        return new String(Base64.getDecoder().decode(value), StandardCharsets.UTF_8);
    }

    private static String json(String value) {
        if (value == null) return "null";
        StringBuilder out = new StringBuilder("\"");
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c == '"' || c == '\\') out.append('\\').append(c);
            else if (c < 32 || Character.isSurrogate(c)) out.append(String.format("\\u%04x", (int)c));
            else out.append(c);
        }
        return out.append('"').toString();
    }

    private static String execute(Connection connection, String sql, int limit) throws SQLException {
        try (Statement statement = connection.createStatement()) {
            statement.setMaxRows(limit + 1);
            try (ResultSet result = statement.executeQuery(sql)) {
                ResultSetMetaData metadata = result.getMetaData();
                int count = metadata.getColumnCount();
                StringBuilder data = new StringBuilder("{\"columns\":[");
                for (int i = 1; i <= count; i++) {
                    if (i > 1) data.append(',');
                    data.append("{\"name\":").append(json(metadata.getColumnLabel(i)))
                        .append(",\"type\":").append(json(metadata.getColumnTypeName(i))).append('}');
                }
                data.append("],\"rows\":[");
                int rows = 0;
                boolean truncated = false;
                while (result.next()) {
                    if (rows == limit) { truncated = true; break; }
                    int offset = data.length();
                    if (rows > 0) data.append(',');
                    data.append('[');
                    for (int i = 1; i <= count; i++) {
                        if (i > 1) data.append(',');
                        String cell = result.getString(i);
                        if (cell != null && cell.length() > 192000) {
                            return "{\"error\":\"size\"}";
                        }
                        data.append(json(cell));
                        if (data.length() > 2_000_000) {
                            data.setLength(offset);
                            return data.append("],\"truncated\":true}").toString();
                        }
                    }
                    data.append(']');
                    rows++;
                }
                return data.append("],\"truncated\":").append(truncated).append('}').toString();
            }
        }
    }

    private static String sqlError(SQLException error) {
        String state = error.getSQLState();
        if (state == null || !state.matches("[A-Z0-9]{5}")) state = "";
        int code = error.getErrorCode();
        boolean timeout = error instanceof SQLTimeoutException || code == 4202 || code == 4203
            || String.valueOf(error.getMessage()).matches("(?is).*(?:ERR_SQL_QUERY(?:_MERGE)?_TIMEOUT|TDDL[- :]?420[23]).*");
        return "{\"error\":\"sql\",\"state\":" + json(state) + ",\"code\":" + code + ",\"timeout\":" + timeout + "}";
    }

    public static void main(String[] args) throws IOException {
        PrintWriter out = new PrintWriter(new OutputStreamWriter(System.out, StandardCharsets.UTF_8), true);
        try (BufferedReader input = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8))) {
            try {
                Class<?> driver = Class.forName("com.mysql.cj.jdbc.Driver");
                String version = driver.getPackage().getImplementationVersion();
                if (version == null || !version.matches("\\d+\\.\\d+\\.\\d+.*")) throw new ReflectiveOperationException();
                String[] parts = version.split("\\D+", 4);
                int major = Integer.parseInt(parts[0]), minor = Integer.parseInt(parts[1]), patch = Integer.parseInt(parts[2]);
                if (major < 8 || (major == 8 && minor == 0 && patch < 12)) throw new ReflectiveOperationException();
            } catch (ReflectiveOperationException | LinkageError problem) {
                out.println("{\"error\":\"driver\"}");
                return;
            }
            String header = input.readLine();
            if (header == null) return;
            String[] config = header.split(" ", -1);
            Properties properties = new Properties();
            properties.setProperty("user", decode(config[1]));
            properties.setProperty("password", decode(config[2]));
            String sslMode = decode(config[3]);
            if (!"VERIFY_IDENTITY".equals(sslMode) && !"DISABLED".equals(sslMode)) {
                throw new IllegalArgumentException("Unsupported JDBC TLS mode");
            }
            properties.setProperty("sslMode", sslMode);
            properties.setProperty("allowPublicKeyRetrieval", "false");
            properties.setProperty("allowLoadLocalInfile", "false");
            properties.setProperty("allowUrlInLocalInfile", "false");
            properties.setProperty("allowMultiQueries", "false");
            properties.setProperty("autoReconnect", "false");
            properties.setProperty("connectTimeout", "5000");
            properties.setProperty("socketTimeout", "9000");
            properties.setProperty("enableQueryTimeouts", "false");
            try (Connection connection = DriverManager.getConnection(decode(config[0]), properties)) {
                connection.setReadOnly(true);
                out.println("{\"ready\":true}");
                for (String line; (line = input.readLine()) != null;) {
                    String[] request = line.split(" ", 2);
                    try {
                        out.println(execute(connection, decode(request[1]), Integer.parseInt(request[0])));
                    } catch (SQLException error) {
                        out.println(sqlError(error));
                        return;
                    }
                }
            } catch (SQLException error) {
                out.println(sqlError(error));
            }
        }
    }
}
