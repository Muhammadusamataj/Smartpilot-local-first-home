package com.example.tuyalocalkey.offline;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.security.SecureRandom;
import java.util.Enumeration;

/** Network facts shared by the activity and the always-on local service. */
final class NetworkUtils {
    private NetworkUtils() {
    }

    /**
     * The phone's Wi-Fi /24, used as a scan hint for the local device API.
     * No location permission is needed: LinkProperties exposes the address of
     * the network the app is actually sending on.
     */
    static String wifiSubnet(Context context) {
        try {
            ConnectivityManager manager =
                    (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (manager == null) return "";
            Network[] networks = manager.getAllNetworks();
            if (networks == null) return "";
            for (Network network : networks) {
                NetworkCapabilities caps = manager.getNetworkCapabilities(network);
                if (caps == null || !caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) continue;
                LinkProperties links = manager.getLinkProperties(network);
                if (links == null) continue;
                for (LinkAddress address : links.getLinkAddresses()) {
                    if (!(address.getAddress() instanceof Inet4Address)) continue;
                    String ip = address.getAddress().getHostAddress();
                    if (ip == null || ip.equals("0.0.0.0") || ip.startsWith("127.")) continue;
                    // /24 keeps a scan inside the app's MAX_ADDRESSES limit.
                    return ip + "/24";
                }
            }
        } catch (Exception e) {
            return "";
        }
        return "";
    }

    /** Tailscale's CGNAT range (100.64.0.0/10), only used in opt-in direct mode. */
    static String tailscaleIp() {
        try {
            Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
            while (interfaces != null && interfaces.hasMoreElements()) {
                Enumeration<InetAddress> addresses = interfaces.nextElement().getInetAddresses();
                while (addresses.hasMoreElements()) {
                    InetAddress address = addresses.nextElement();
                    if (!(address instanceof Inet4Address)) continue;
                    byte[] octets = address.getAddress();
                    if ((octets[0] & 0xff) == 100 && (octets[1] & 0xc0) == 64) {
                        return address.getHostAddress();
                    }
                }
            }
        } catch (Exception ignored) {
            // Not on a tailnet is a normal state.
        }
        return "";
    }

    /** Fresh credential for direct mode; never a bundled or device key. */
    static String randomToken() {
        byte[] bytes = new byte[12];
        new SecureRandom().nextBytes(bytes);
        StringBuilder token = new StringBuilder();
        for (byte value : bytes) token.append(String.format("%02x", value & 0xff));
        return token.toString();
    }
}
