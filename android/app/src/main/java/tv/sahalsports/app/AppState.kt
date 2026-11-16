package tv.sahalsports.app

import android.app.Application
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.net.URI

class AppState(application: Application) : AndroidViewModel(application) {
    private val preferences = application.getSharedPreferences("connection", 0)
    private val vault = SessionVault(application)
    val api = Api(preferences.getString("base_url", BuildConfig.API_BASE_URL)!!)
    var route by mutableStateOf("welcome")
    private val history = mutableStateListOf<String>()
    var user by mutableStateOf<JSONObject?>(null)
    var account by mutableStateOf(JSONObject())
    var bootstrap by mutableStateOf(JSONObject())
    var busy by mutableStateOf(false)
    var message by mutableStateOf<String?>(null)
    var connectionError by mutableStateOf<String?>(null)
    var selectedChannel by mutableStateOf<JSONObject?>(null)
    var category by mutableStateOf("All")
    var payment by mutableStateOf<JSONObject?>(null)
    var playback by mutableStateOf<JSONObject?>(null)
    val isAdmin get() = user?.text("role") == "admin"
    val categories = listOf("Football", "Basketball", "Tennis", "UFC", "Cricket", "Other Sports")
    val channels get() = bootstrap.optJSONArray("channels")?.objects().orEmpty()
    init {
        api.token = vault.load()
        refreshCatalogue()
        if (api.token != null) perform {
            account = api.call("GET", "/me")
            user = account.optJSONObject("user")
            nav(if (isAdmin) "admin/dashboard" else "home")
            registerNotifications()
        }
    }
    fun go(destination: String) { history.add(route); route = destination }
    fun nav(destination: String) { history.clear(); route = destination }
    fun back() { playback = null; route = if (history.isNotEmpty()) history.removeAt(history.lastIndex) else if (isAdmin) "admin/dashboard" else "home" }
    fun perform(action: suspend () -> Unit) {
        if (busy) return
        viewModelScope.launch {
            busy = true
            try { action() }
            catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                if (e is ApiException && e.status == 401) {
                    api.token = null; vault.save(null); user = null; account = JSONObject(); playback = null
                    PushSupport.clear()
                    nav("login")
                }
                message = e.message ?: "Something went wrong. Please try again."
            } finally { busy = false }
        }
    }
    fun refreshCatalogue() {
        viewModelScope.launch {
            try { bootstrap = api.call("GET", "/bootstrap"); connectionError = null }
            catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                connectionError = e.message
            }
        }
    }
    suspend fun refreshAccount() { account = api.call("GET", "/me"); user = account.optJSONObject("user") }
    private fun registerNotifications() {
        PushSupport.sessionToken = api.token
        if (!PushSupport.configured) return
        viewModelScope.launch {
            try { PushSupport.register(api) }
            catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                message = "Notifications could not be registered. You can retry from Notifications."
            }
        }
    }
    fun login(identifier: String, password: String, remember: Boolean, admin: Boolean = false) = perform {
        val result = api.call("POST", "/auth/login", json("identifier" to identifier.trim(), "password" to password))
        api.token = result.text("token")
        val signedIn = result.optJSONObject("user")
        if (admin && signedIn?.text("role") != "admin") {
            api.call("POST", "/auth/logout"); api.token = null
            throw IllegalArgumentException("This account does not have administrator permission.")
        }
        user = signedIn
        vault.save(if (remember) api.token else null)
        refreshAccount()
        nav(if (isAdmin) "admin/dashboard" else "home")
        registerNotifications()
    }
    fun register(name: String, phone: String, email: String, password: String) = perform {
        val result = api.call("POST", "/auth/register", json("name" to name.trim(), "phone" to phone.trim(), "email" to email.trim(), "password" to password))
        api.token = result.text("token"); user = result.optJSONObject("user"); vault.save(null)
        refreshAccount(); nav("home"); registerNotifications()
    }
    fun logout() = perform {
        try { api.call("POST", "/auth/logout") }
        finally {
            api.token = null; vault.save(null); user = null; account = JSONObject(); payment = null; playback = null
            PushSupport.clear()
            nav("welcome")
        }
    }
    fun requireLogin(destination: String) { if (user == null) go("login") else go(destination) }
    fun startTrial() {
        if (user == null) { go("login"); return }
        perform { api.call("POST", "/trial/start"); refreshAccount(); go("trial") }
    }
    fun play(channel: JSONObject) {
        selectedChannel = channel
        if (user == null) { go("login"); return }
        perform {
            try {
                playback = api.call("GET", "/channels/${channel.text("id")}/playback")
                go("player")
            } catch (e: ApiException) {
                if (e.status == 402 || e.status == 403) { refreshAccount(); go("subscription") }
                throw e
            }
        }
    }
    fun pay(provider: String, phone: String) = perform {
        payment = api.call("POST", "/payments", json("provider" to provider, "phone" to phone.trim()))
        go("payment-status")
    }
    fun verifyPayment() = perform {
        val id = payment?.text("id").orEmpty()
        require(id.isNotBlank()) { "No payment is awaiting verification." }
        payment = api.call("GET", "/payments/$id")
        refreshAccount()
        if (payment?.text("status") in listOf("successful", "succeeded", "completed") && account.optJSONObject("subscription")?.optBoolean("active") == true) go("success")
        else message = "Payment status: ${payment?.text("status", "pending")}. Only the payment provider can confirm payment."
    }
    fun setServer(value: String) {
        runCatching {
            val uri = URI(value.trim())
            require(uri.host != null && uri.userInfo == null && uri.query == null && uri.fragment == null &&
                (uri.scheme == "https" || (BuildConfig.DEBUG && uri.scheme == "http"))) { "Enter a valid HTTPS backend address." }
            val base = value.trim().trimEnd('/').let { if (it.endsWith("/v1")) it else "$it/v1" }
            api.token = null; vault.save(null); user = null; account = JSONObject(); payment = null; playback = null
            PushSupport.clear()
            api.baseUrl = base; preferences.edit().putString("base_url", base).apply()
            bootstrap = JSONObject(); refreshCatalogue(); nav("welcome"); message = "Backend address saved."
        }.onFailure { message = it.message }
    }
}
