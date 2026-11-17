package tv.sahalsports.app

import android.content.Intent
import android.provider.Settings
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable fun AccountScreen(vm: AppState) {
    val context = LocalContext.current
    LaunchedEffect(vm.route) { if (vm.user != null && vm.route in listOf("profile", "history")) vm.perform { vm.refreshAccount() } }
    Page {
        when (vm.route) {
            "profile" -> {
                Heading("Your corner.", "Everything you need, in one place.")
                if (vm.user == null) {
                    EmptyState("Make yourself at home", "Sign in to manage your subscription and account.", Icons.Rounded.PersonOutline, "Sign in") { vm.go("login") }
                    ActionButton("Create an account", gold = true) { vm.go("register") }
                } else {
                    AppCard {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                            Box(Modifier.size(57.dp).clip(CircleShape).background(Purple.copy(alpha = .25f)), contentAlignment = Alignment.Center) {
                                Text(vm.user?.text("name")?.take(1)?.uppercase().orEmpty(), fontWeight = FontWeight.Bold, color = Gold, fontSize = 25.sp)
                            }
                            Column { Text(vm.user?.text("name").orEmpty(), fontSize = 19.sp, fontWeight = FontWeight.Bold)
                                Badge(if (vm.account.optJSONObject("subscription")?.optBoolean("active") == true) "PREMIUM MEMBER" else "SPORTS FAN") }
                        }
                        HorizontalDivider(color = Line)
                        Detail("Email", vm.user?.text("email").orEmpty())
                        Detail("Phone", vm.user?.text("phone").orEmpty())
                        Detail("Subscription expires", formatDate(vm.account.optJSONObject("subscription")?.text("expiresAt").orEmpty()))
                    }
                    Column {
                        MenuRow("My subscription", "Your access to every moment", Icons.Rounded.WorkspacePremium) { vm.go("subscription") }
                        MenuRow("Free trial", "View your remaining time", Icons.Rounded.Timer) { vm.go("trial") }
                        MenuRow("Payment history", icon = Icons.Rounded.ReceiptLong) { vm.go("history") }
                        MenuRow("Change password", icon = Icons.Rounded.Lock) { vm.go("password") }
                        MenuRow("Settings", icon = Icons.Rounded.Settings) { vm.go("settings") }
                        MenuRow("Help & support", icon = Icons.Rounded.HelpOutline) { vm.go("support") }
                    }
                    OutlinedButton(onClick = { vm.logout() }, enabled = !vm.busy, modifier = Modifier.fillMaxWidth()) { Icon(Icons.Rounded.Logout, null, Modifier.size(18.dp)); Text("  Log out") }
                }
                Text("SAHAL SPORTS TV · VERSION ${BuildConfig.VERSION_NAME}", color = Muted, fontSize = 10.sp, letterSpacing = 1.sp, modifier = Modifier.align(Alignment.CenterHorizontally))
            }
            "history" -> {
                Heading("Your payments", "Verified transactions and subscription purchases.")
                val payments = vm.account.optJSONArray("payments")?.objects().orEmpty()
                if (vm.user == null) EmptyState("Sign in to continue", "Payment history belongs to your secure account.", action = "Sign in") { vm.go("login") }
                else if (payments.isEmpty()) EmptyState("No payments yet", "Your mobile money transactions will appear here.", Icons.Rounded.ReceiptLong)
                payments.forEach { item ->
                    AppCard {
                        Badge(item.text("status").uppercase())
                        Detail("Provider", item.text("provider").uppercase())
                        Detail("Amount", "${item.text("currency", "USD")} ${item.text("amount", "0.50")}")
                        Detail("Date", formatDate(item.text("createdAt")))
                        Detail("Reference", item.text("reference", item.text("id")))
                    }
                }
            }
            "settings" -> {
                Heading("Make it yours.")
                Column {
                    MenuRow("Account settings", icon = Icons.Rounded.ManageAccounts) { vm.nav("profile") }
                    MenuRow("Language", "English", Icons.Rounded.Language) { vm.go("language") }
                    MenuRow("Notifications", "Manage device permissions", Icons.Rounded.NotificationsNone) {
                        context.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName))
                    }
                    MenuRow("Privacy policy", icon = Icons.Rounded.PrivacyTip) { vm.go("privacy") }
                    MenuRow("Terms & conditions", icon = Icons.Rounded.Description) { vm.go("terms") }
                    MenuRow("Help & support", icon = Icons.Rounded.HelpOutline) { vm.go("support") }
                    MenuRow("About Sahal Sports TV", icon = Icons.Rounded.Info) { vm.go("about") }
                    MenuRow("Backend connection", icon = Icons.Rounded.Dns) { vm.go("connection") }
                }
            }
            "connection" -> {
                var address by rememberSaveable { mutableStateOf(vm.api.baseUrl) }
                Heading("Connect your service", "Enter the secure backend address supplied by your app administrator.")
                Field("Backend URL", address, { address = it }, keyboard = KeyboardType.Uri, icon = Icons.Rounded.Dns)
                ActionButton("Save connection") { vm.setServer(address) }
                AppCard {
                    Text("Production uses HTTPS", color = Gold, fontWeight = FontWeight.Bold)
                    Text("Payment credentials are stored only on the backend. Never enter ZAAD or eDahab API keys in the customer app.", fontSize = 13.sp, color = Muted, lineHeight = 21.sp)
                    if (BuildConfig.DEBUG) Text("Development build: HTTP is allowed for local testing. The default address targets an Android emulator.", color = Muted, fontSize = 12.sp)
                }
            }
            "password" -> {
                var current by remember { mutableStateOf("") }
                var password by remember { mutableStateOf("") }
                var confirm by remember { mutableStateOf("") }
                Heading("Keep your account safe", "Choose a unique password of at least 12 characters.")
                Field("Current password", current, { current = it }, secret = true)
                Field("New password", password, { password = it }, secret = true)
                Field("Confirm new password", confirm, { confirm = it }, secret = true)
                ActionButton("Update password", enabled = !vm.busy && current.isNotBlank() && password.length >= 12 && password == confirm) {
                    vm.perform {
                        vm.api.call("POST", "/me/password", json("currentPassword" to current, "newPassword" to password))
                        current = ""; password = ""; confirm = ""; vm.message = "Password updated. Sign in again if your session has expired."
                    }
                }
            }
            "language" -> {
                Heading("Language", "The application interface is available in English.")
                AppCard { Row(verticalAlignment = Alignment.CenterVertically) { Icon(Icons.Rounded.Language, null, tint = Gold); Text("  English", Modifier.weight(1f)); Icon(Icons.Rounded.CheckCircle, "Selected", tint = Green) } }
            }
            "notifications" -> {
                var notices by remember { mutableStateOf<List<org.json.JSONObject>>(emptyList()) }
                var loadError by remember { mutableStateOf<String?>(null) }
                var revision by remember { mutableIntStateOf(0) }
                LaunchedEffect(revision) {
                    if (vm.user != null) try { notices = vm.api.call("GET", "/notifications").items(); loadError = null }
                    catch (e: Exception) { if (e is kotlinx.coroutines.CancellationException) throw e; loadError = e.message }
                }
                Heading("Stay in the game.")
                EnableNotificationsButton(vm)
                if (loadError != null) EmptyState("Could not load updates", loadError!!, action = "Retry") { revision++ }
                else if (notices.isEmpty()) EmptyState("All quiet for now", "Updates from your sports service will appear here.", Icons.Rounded.NotificationsNone)
                notices.forEach { notice -> AppCard {
                    Text(notice.text("title"), fontWeight = FontWeight.Bold)
                    Text(notice.text("body"), color = Muted, fontSize = 13.sp)
                    Text(formatDate(notice.text("createdAt")), color = Gold, fontSize = 11.sp)
                } }
            }
            "support" -> {
                Heading("We're on your side.", "Help with your account, payments and streaming.")
                AppCard {
                    Text("Payment pending?", fontWeight = FontWeight.Bold)
                    Text("Keep your transaction reference. Never send your mobile money PIN or password to anyone claiming to be support.", color = Muted, fontSize = 13.sp, lineHeight = 21.sp)
                }
                if (vm.supportEmail.isNotBlank() || vm.supportPhone.isNotBlank()) AppCard {
                    Text("Contact the service", fontWeight = FontWeight.Bold)
                    if (vm.supportEmail.isNotBlank()) Detail("Support email", vm.supportEmail)
                    if (vm.supportPhone.isNotBlank()) Detail("Support phone", vm.supportPhone)
                } else Text("The service operator has not published a support contact yet.", color = Muted, fontSize = 12.sp)
                MenuRow("Review payment history", icon = Icons.Rounded.ReceiptLong) { vm.requireLogin("history") }
                MenuRow("Connection troubleshooting", icon = Icons.Rounded.Wifi) { vm.go("connection") }
            }
            "privacy" -> {
                Heading("Privacy & your data")
                AppCard {
                    Text("Your account information", fontWeight = FontWeight.Bold)
                    Text("The backend processes your name, phone number, email, subscription and payment references to provide access. Mobile money PINs are never requested by this app. Payment verification is handled server-to-server.", color = Muted, fontSize = 13.sp, lineHeight = 22.sp)
                    Text("Your session token is encrypted with Android Keystore and restored automatically on launch. Admin actions are audited on the backend.", color = Muted, fontSize = 13.sp, lineHeight = 22.sp)
                }
                Text("Release requirement: the operator must publish their legal identity, retention policy, support contact and data rights procedure.", color = Gold, fontSize = 12.sp, lineHeight = 20.sp)
            }
            "terms" -> {
                Heading("Service terms", "Launch draft — subject to the operator's published legal terms.")
                AppCard {
                    Text("Premium access", fontWeight = FontWeight.Bold)
                    Text("A monthly subscription costs ${vm.priceLabel}. Eligible accounts may start one ${vm.trialMinutes}-minute free trial. Trial time runs continuously after activation, including when the app is closed. Access stops when the trial or subscription expires.", color = Muted, fontSize = 13.sp, lineHeight = 22.sp)
                    Text("Only licensed content may be distributed. Channel availability depends on the service operator's rights and configuration. Payment access begins only after provider verification.", color = Muted, fontSize = 13.sp, lineHeight = 22.sp)
                }
                Text("The operator must publish final licensing, refund, cancellation and support terms before accepting public subscriptions.", color = Gold, fontSize = 12.sp, lineHeight = 20.sp)
            }
            "about" -> {
                Brand(large = true)
                Heading("Sahal Sports TV", "Watch Live Sports, Anytime, Anywhere")
                AppCard { Detail("Version", BuildConfig.VERSION_NAME); Detail("Platform", "Native Android"); Detail("Plan", "${vm.priceLabel} / month"); Detail("Free trial", "${vm.trialMinutes} minutes") }
                Text("One application. A complete customer experience and a separate, role-protected mobile administration workspace.", color = Muted, fontSize = 13.sp, lineHeight = 22.sp)
                if (vm.user == null) TextButton(onClick = { vm.go("admin-login") }) { Text("Administrator sign in") }
            }
        }
    }
}
