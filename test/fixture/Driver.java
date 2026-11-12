package com.mysql.cj.jdbc;

import java.lang.reflect.*;
import java.sql.*;
import java.util.*;
import java.util.logging.Logger;

public final class Driver implements java.sql.Driver {
    static { try { DriverManager.registerDriver(new Driver()); } catch (SQLException e) { throw new ExceptionInInitializerError(e); } }
    private static <T> T proxy(Class<T> type, InvocationHandler handler) {
        return type.cast(Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type}, handler));
    }
    private static ResultSet grid(String[] columns, String[][] rows) {
        ResultSetMetaData meta = proxy(ResultSetMetaData.class, (p,m,a)-> {
            switch (m.getName()) {
                case "getColumnCount": return columns.length;
                case "getColumnLabel": return columns[(int)a[0]-1];
                case "getColumnTypeName": return "TEST";
                default: throw new AssertionError(m.getName());
            }
        });
        int[] current = {-1};
        return proxy(ResultSet.class, (p,m,a)->{
            switch (m.getName()) {
                case "next": return ++current[0] < rows.length;
                case "getMetaData": return meta;
                case "getString": return rows[current[0]][(int)a[0]-1];
                case "close": return null;
                default: throw new AssertionError(m.getName());
            }
        });
    }
    @Override public Connection connect(String url, Properties props) throws SQLException {
        if (!acceptsURL(url)) throw new SQLException("No network in this fixture.");
        String expectedTls = url.contains(":3307/") ? "DISABLED" : "VERIFY_IDENTITY";
        if (!expectedTls.equals(props.getProperty("sslMode")) || !"false".equals(props.getProperty("allowMultiQueries"))
                || !"false".equals(props.getProperty("allowPublicKeyRetrieval")) || !"false".equals(props.getProperty("allowLoadLocalInfile"))
                || !"false".equals(props.getProperty("autoReconnect")) || !"5000".equals(props.getProperty("connectTimeout"))
                || !"9000".equals(props.getProperty("socketTimeout")) || !"reader".equals(props.getProperty("user")))
            throw new AssertionError("Expected strict connection properties.");
        boolean[] readonly = {false};
        return proxy(Connection.class, (p,m,a)->{
            switch (m.getName()) {
                case "close": return null;
                case "setReadOnly": readonly[0] = (boolean)a[0]; return null;
                case "createStatement":
                    if (!readonly[0]) throw new AssertionError("Connection must be read-only.");
                    return proxy(Statement.class, (q,method,args)->{
                        switch (method.getName()) {
                            case "close": case "setMaxRows": return null;
                            case "executeQuery":
                                String sql = ((String)args[0]).toLowerCase(Locale.ROOT);
                                if (sql.startsWith("show create table `sandbox`.")) return grid(new String[]{"Table","Create Table"},new String[][]{{"products","CREATE TABLE products (id BIGINT)"}});
                                if (sql.startsWith("describe `sandbox`.")) return grid(new String[]{"Field","Type"},new String[][]{{"id","BIGINT"},{"user_phone","VARCHAR(64)"}});
                                if (sql.startsWith("show index")) return grid(new String[]{"Key_name","Seq_in_index","Column_name"},new String[][]{{"PRIMARY","1","id"}});
                                if (sql.startsWith("explain sharding")) return grid(new String[]{"SHARD_COUNT"},new String[][]{{sql.contains("two_shards") ? "2" : "1"}});
                                if (sql.startsWith("explain execute")) return grid(new String[]{"rows"},new String[][]{{"100000"}});
                                if (sql.startsWith("/*tddl:socket_timeout=5000*/")) {
                                    if (sql.contains("drds_timeout_vendor")) throw new SQLException("ERR_SQL_QUERY_TIMEOUT", "HY000", 4202);
                                    if (sql.contains("drds_timeout_message")) throw new SQLException("ERR_SQL_QUERY_MERGE_TIMEOUT", "HY000", 0);
                                    return grid(new String[]{"id"},new String[][]{{"1"}});
                                }
                                if (sql.startsWith("explain select `id` from `sandbox`.")) {
                                    if (sql.contains("limit") || sql.contains("phone")) throw new AssertionError("Expected full-scan plan of safe fields.");
                                    if (url.contains(":9030/")) return grid(new String[]{"Plan"},new String[][]{{"0:VOlapScanNode(2)\n | cardinality=10,000,000, avgRowSize=1"}});
                                    return grid(new String[]{"rows"},new String[][]{{sql.contains("unknown") ? null : sql.contains("too_large") ? "100001" : "100000"}});
                                }
                                if (sql.startsWith("explain") && url.contains(":9030/")) return grid(new String[]{"Plan"},new String[][]{{"VOlapScanNode\ncardinality=1"}});
                                if (sql.startsWith("explain")) return grid(new String[]{"rows"},new String[][]{{sql.contains("999") ? "100001" : "1"}});
                                if (sql.contains("timeout_probe")) throw new SQLException("Synthetic timeout", "HYT00", 0);
                                if (sql.contains("999")) throw new AssertionError("Rejected SQL reached execution.");
                                if (sql.startsWith("select /*+ ")) {
                                    if (sql.contains("unknown") || sql.contains("too_large") || sql.contains("phone")
                                            || !sql.endsWith("limit 100")) throw new AssertionError("Unexpected preview query.");
                                    if (sql.contains("preview_timeout")) throw new SQLException("Synthetic timeout", "HYT00", 0);
                                    String[][] rows = new String[110][1];
                                    for (int i=0; i<rows.length; i++) rows[i][0]=Integer.toString(i);
                                    return grid(new String[]{"id"},rows);
                                }
                                if (sql.startsWith("select")) return grid(new String[]{"same","same"},new String[][]{{"9007199254740993",null}});
                                throw new AssertionError("Unexpected SQL.");
                            default: throw new AssertionError(method.getName());
                        }
                    });
                default: throw new AssertionError(m.getName());
            }
        });
    }
    @Override public boolean acceptsURL(String url) { return url.startsWith("jdbc:mysql://fixture.invalid:"); }
    @Override public int getMajorVersion() { return 8; }
    @Override public int getMinorVersion() { return 0; }
    @Override public boolean jdbcCompliant() { return false; }
    @Override public DriverPropertyInfo[] getPropertyInfo(String url, Properties props) { return new DriverPropertyInfo[0]; }
    @Override public Logger getParentLogger() { return Logger.getGlobal(); }
}
