package tv.sahalsports.app

import android.Manifest
import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class SahalApplication : Application() {
    override fun onCreate() { super.onCreate(); PushSupport.initialize(this) }
}
object PushSupport {
    @Volatile var sessionToken: String? = null
    val configured get() = listOf(BuildConfig.FIREBASE_APP_ID, BuildConfig.FIREBASE_API_KEY, BuildConfig.FIREBASE_PROJECT_ID, BuildConfig.FIREBASE_SENDER_ID).all { it.isNotBlank() }
    fun initialize(context: Context) {
        if (configured && FirebaseApp.getApps(context).isEmpty()) {
            FirebaseApp.initializeApp(context, FirebaseOptions.Builder().setApplicationId(BuildConfig.FIREBASE_APP_ID)
                .setApiKey(BuildConfig.FIREBASE_API_KEY).setProjectId(BuildConfig.FIREBASE_PROJECT_ID)
                .setGcmSenderId(BuildConfig.FIREBASE_SENDER_ID).build())
        }
    }
    suspend fun register(api: Api) {
        require(configured) { "Firebase notifications are not configured for this build." }
        require(api.token != null) { "Sign in before enabling notifications." }
        val deviceToken = withContext(Dispatchers.IO) { Tasks.await(FirebaseMessaging.getInstance().token) }
        api.call("POST", "/devices", json("token" to deviceToken))
        sessionToken = api.token
    }
    fun clear() {
        sessionToken = null
        if (configured) FirebaseMessaging.getInstance().deleteToken()
    }
}
class SahalMessagingService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        if (PushSupport.sessionToken == null && SessionVault(this).load() == null) return
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val title = message.data["title"] ?: return
        val body = message.data["body"] ?: return
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel("sahal_updates", "Sports & account updates", NotificationManager.IMPORTANCE_DEFAULT))
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val notification = NotificationCompat.Builder(this, "sahal_updates").setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle(title).setContentText(body).setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(open).setAutoCancel(true).build()
        manager.notify((message.messageId ?: title).hashCode(), notification)
    }
}
@Composable fun EnableNotificationsButton(vm: AppState) {
    val context = LocalContext.current
    val register = {
        if (vm.user == null) vm.go("login")
        else vm.perform { PushSupport.register(vm.api); vm.message = "This device is registered for notifications." }
    }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) register() else vm.message = "Notifications remain off. You can enable them in Android settings."
    }
    OutlinedButton(onClick = {
        if (!PushSupport.configured) vm.message = "Firebase notifications are not configured for this build."
        else if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) permission.launch(Manifest.permission.POST_NOTIFICATIONS)
        else register()
    }, enabled = !vm.busy) { Text("Enable notifications on this device") }
}
