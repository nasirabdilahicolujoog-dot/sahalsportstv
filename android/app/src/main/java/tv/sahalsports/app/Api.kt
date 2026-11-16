package tv.sahalsports.app

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.security.KeyStore
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class ApiException(val status: Int, message: String) : IOException(message)

class SessionVault(context: Context) {
    private val prefs = context.getSharedPreferences("sahal_secure", Context.MODE_PRIVATE)
    private val alias = "sahal_session_key"
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        return (store.getKey(alias, null) as? SecretKey) ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
            generateKey()
        }
    }
    fun save(token: String?) {
        if (token == null) { prefs.edit().remove("token").remove("iv").apply(); return }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        prefs.edit().putString("token", Base64.encodeToString(cipher.doFinal(token.toByteArray()), Base64.NO_WRAP))
            .putString("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP)).apply()
    }
    fun load(): String? = runCatching {
        val encrypted = prefs.getString("token", null) ?: return null
        val iv = prefs.getString("iv", null) ?: return null
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)))
        }
        String(cipher.doFinal(Base64.decode(encrypted, Base64.NO_WRAP)))
    }.getOrElse { save(null); null }
}

class Api(var baseUrl: String) {
    @Volatile var token: String? = null
    private val client = OkHttpClient.Builder().connectTimeout(12, TimeUnit.SECONDS).readTimeout(20, TimeUnit.SECONDS)
        .followRedirects(false).build()
    suspend fun call(method: String, path: String, data: JSONObject? = null): JSONObject = withContext(Dispatchers.IO) {
        val url = baseUrl.trimEnd('/') + path
        require(BuildConfig.DEBUG || url.startsWith("https://")) { "A secure HTTPS backend is required." }
        val body = if (method == "GET" || method == "DELETE") null else (data ?: JSONObject()).toString().toRequestBody("application/json".toMediaType())
        val request = Request.Builder().url(url).method(method, body).header("Accept", "application/json")
        token?.let { request.header("Authorization", "Bearer $it") }
        try {
            client.newCall(request.build()).execute().use { response ->
                val raw = response.body?.string().orEmpty()
                val json = runCatching { JSONObject(raw) }.getOrDefault(JSONObject())
                if (!response.isSuccessful) throw ApiException(response.code, json.optJSONObject("error")?.optString("message")
                    ?.takeIf { it.isNotBlank() } ?: "The server could not complete this request (${response.code}).")
                json
            }
        } catch (e: ApiException) { throw e }
        catch (e: IOException) { throw IOException("Cannot reach $baseUrl. Check Wi-Fi and the backend address.", e) }
    }
}
fun json(vararg values: Pair<String, Any?>) = JSONObject().apply { values.forEach { (key, value) -> put(key, value ?: JSONObject.NULL) } }
fun JSONArray.objects(): List<JSONObject> = (0 until length()).mapNotNull { optJSONObject(it) }
fun JSONObject.items(): List<JSONObject> = optJSONArray("items")?.objects().orEmpty()
fun JSONObject.text(key: String, fallback: String = ""): String = if (isNull(key)) fallback else optString(key, fallback)
