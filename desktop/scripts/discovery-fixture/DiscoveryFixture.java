package test.ct45.discovery;

import android.app.Activity;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.os.Bundle;
import android.util.Log;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;

// Test-only bridge for emulator networks that cannot receive the host's multicast packets.
// Advertises a new endpoint via real Android NSD, forwarding opaque TLS bytes to the desktop.
// Never packaged with CT45 Computer Link or included in release downloads.
public class DiscoveryFixture extends Activity {
    private ServerSocket listener;
    private NsdManager nsd;
    private NsdManager.RegistrationListener registration;
    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        String id = getIntent().getStringExtra("id");
        int target = getIntent().getIntExtra("targetPort", 18768);
        new Thread(() -> {
            try {
                listener = new ServerSocket(18769);
                runOnUiThread(() -> advertise(id));
                while (!listener.isClosed()) {
                    Socket incoming = listener.accept();
                    Socket outgoing = new Socket("10.0.2.2", target);
                    new Thread(() -> pipe(incoming, outgoing)).start();
                    new Thread(() -> pipe(outgoing, incoming)).start();
                }
            } catch (Exception e) { Log.e("CT45Fixture", "Bridge stopped", e); }
        }).start();
    }
    private void advertise(String id) {
        nsd = getSystemService(NsdManager.class);
        NsdServiceInfo info = new NsdServiceInfo();
        info.setServiceName("ct45-" + id);
        info.setServiceType("_ct45link._tcp.");
        info.setPort(18769);
        info.setAttribute("id", id);
        info.setAttribute("v", "2");
        registration = new NsdManager.RegistrationListener() {
            public void onServiceRegistered(NsdServiceInfo s) { Log.i("CT45Fixture", "Registered " + s); }
            public void onRegistrationFailed(NsdServiceInfo s, int e) { Log.e("CT45Fixture", "Registration failed " + e); }
            public void onServiceUnregistered(NsdServiceInfo s) {}
            public void onUnregistrationFailed(NsdServiceInfo s, int e) {}
        };
        nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, registration);
    }
    private static void pipe(Socket from, Socket to) {
        try {
            InputStream in = from.getInputStream();
            OutputStream out = to.getOutputStream();
            byte[] buffer = new byte[16384];
            int n;
            while ((n = in.read(buffer)) != -1) { out.write(buffer, 0, n); out.flush(); }
        } catch (Exception ignored) {} finally {
            try { from.close(); to.close(); } catch (Exception ignored) {}
        }
    }
}
