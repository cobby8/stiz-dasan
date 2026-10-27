package kr.stiz.driver;

import org.json.JSONObject;
import java.net.URL;
import javax.net.ssl.HttpsURLConnection;

final class DriverApi {
    static JSONObject call(JSONObject session, String action, JSONObject fields) throws Exception {
        if (BuildConfig.STIZ_SANDBOX) throw new java.io.IOException("Synthetic sandbox does not send device location or run credentials");
        fields.put("action", action).put("sessionId", session.getString("sessionId"));
        if (action.equals("start")) fields.put("token", session.getString("token")).put("secret", session.getString("secret")).put("deviceId", session.getString("deviceId"));
        HttpsURLConnection connection = (HttpsURLConnection) new URL(BuildConfig.STIZ_ORIGIN + "/api/driver/mobile/session").openConnection();
        try {
            connection.setRequestMethod("POST"); connection.setConnectTimeout(12000); connection.setReadTimeout(12000);
            connection.setInstanceFollowRedirects(false); connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setRequestProperty("Authorization", "Bearer " + session.getString("secret"));
            byte[] body = fields.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(body.length);
            try (java.io.OutputStream output = connection.getOutputStream()) { output.write(body); }
            int status = connection.getResponseCode();
            java.io.InputStream input = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            String text = "";
            if (input != null) try (input; java.io.ByteArrayOutputStream buffer = new java.io.ByteArrayOutputStream()) {
                byte[] chunk = new byte[4096]; int length;
                while ((length = input.read(chunk)) != -1) { if (buffer.size() + length > 65536) throw new java.io.IOException("Response too large"); buffer.write(chunk, 0, length); }
                text = buffer.toString("UTF-8");
            }
            JSONObject response = text.isEmpty() ? new JSONObject() : new JSONObject(text);
            if (status < 200 || status >= 300 || !response.optBoolean("ok")) throw new ApiFailure(status, response.optString("error"));
            return response;
        } finally { connection.disconnect(); }
    }
    static final class ApiFailure extends Exception {
        final int status;
        final String code;
        ApiFailure(int status, String code) { super("HTTP " + status); this.status = status; this.code = code; }
        boolean terminal() { return "SESSION_ENDED".equals(code) || "RUN_REVOKED".equals(code) || "INVALID_CREDENTIAL".equals(code) || "SESSION_EXPIRED".equals(code); }
    }
}
