package com.srathinagiri.calendar;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Receives text shared to the app (Share -> Calendar App), e.g. a bank SMS.
 *
 * The calendar database is encrypted and opens only after the PIN, so shared text waits in a small
 * app-private queue until the web app is unlocked and calls drain(). drain() returns the items and
 * empties the queue in one step; the web app then saves them into the encrypted database.
 * A "shared" event tells an already-unlocked app that something new is waiting.
 */
@CapacitorPlugin(name = "ShareInbox")
public class ShareInboxPlugin extends Plugin {

    private static final String PREFS = "srg_share_inbox";
    private static final String KEY = "queue";
    private static final int MAX_ITEMS = 500;
    private static final int MAX_CHARS = 20000;

    @Override
    protected void handleOnNewIntent(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return;
        // Reopening the app from Recents re-delivers the original share; don't queue it twice.
        if ((intent.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return;
        String type = intent.getType();
        if (type == null || !type.startsWith("text/")) return;
        CharSequence cs = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        if (cs == null) return;
        String text = cs.toString().trim();
        if (text.isEmpty()) return;
        if (text.length() > MAX_CHARS) text = text.substring(0, MAX_CHARS);

        enqueue(getContext(), text);
        // Handled: make sure the same Intent object is not processed again.
        intent.setAction(Intent.ACTION_MAIN);
        intent.removeExtra(Intent.EXTRA_TEXT);

        notifyListeners("shared", new JSObject(), true);
    }

    private static synchronized void enqueue(Context ctx, String text) {
        SharedPreferences prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        JSONArray queue;
        try {
            queue = new JSONArray(prefs.getString(KEY, "[]"));
        } catch (JSONException e) {
            queue = new JSONArray();
        }
        if (queue.length() >= MAX_ITEMS) return;
        try {
            JSONObject item = new JSONObject();
            item.put("text", text);
            item.put("at", System.currentTimeMillis());
            queue.put(item);
        } catch (JSONException e) {
            return;
        }
        prefs.edit().putString(KEY, queue.toString()).commit();
    }

    private static synchronized JSONArray takeAll(Context ctx) {
        SharedPreferences prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        JSONArray queue;
        try {
            queue = new JSONArray(prefs.getString(KEY, "[]"));
        } catch (JSONException e) {
            queue = new JSONArray();
        }
        prefs.edit().remove(KEY).commit();
        return queue;
    }

    /** Returns { items: [{ text, at }] } and clears the queue. */
    @PluginMethod
    public void drain(PluginCall call) {
        JSONArray queue = takeAll(getContext());
        JSArray items = new JSArray();
        for (int i = 0; i < queue.length(); i++) {
            JSONObject o = queue.optJSONObject(i);
            if (o != null) items.put(o);
        }
        JSObject ret = new JSObject();
        ret.put("items", items);
        call.resolve(ret);
    }

    /** Puts items back if the web app could not save them (e.g. saving is paused). */
    @PluginMethod
    public void requeue(PluginCall call) {
        JSArray items = call.getArray("items");
        if (items != null) {
            for (int i = 0; i < items.length(); i++) {
                JSONObject o = items.optJSONObject(i);
                if (o != null && o.optString("text", "").length() > 0) enqueue(getContext(), o.optString("text"));
            }
        }
        call.resolve();
    }
}
