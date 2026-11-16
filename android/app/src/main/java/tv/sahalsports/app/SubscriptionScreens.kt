package tv.sahalsports.app

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import java.time.Instant

@Composable fun SubscriptionScreen(vm: AppState) {
    LaunchedEffect(Unit) { if (vm.user != null) vm.perform { vm.refreshAccount() } }
    Page {
        Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Box(Modifier.size(78.dp).clip(CircleShape).background(Purple.copy(alpha = .2f)), contentAlignment = Alignment.Center) {
                Icon(Icons.Rounded.WorkspacePremium, null, Modifier.size(46.dp), tint = Gold)
            }
            Badge("THE ULTIMATE SPORTS EXPERIENCE")
            Text("Small price.\nBig sporting moments.", fontSize = 31.sp, lineHeight = 35.sp, fontWeight = FontWeight.ExtraBold, textAlign = TextAlign.Center)
        }
        Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(24.dp)).background(Color(0xFFF9F6FF)).padding(23.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
            Text("SAHAL PREMIUM", color = Color(0xFF371265), letterSpacing = 2.sp, fontSize = 12.sp, fontWeight = FontWeight.Bold)
            Row(verticalAlignment = Alignment.Bottom) {
                Text("$0.50", fontSize = 47.sp, fontWeight = FontWeight.ExtraBold, color = Ink, letterSpacing = (-2).sp)
                Text(" / month", fontSize = 14.sp, color = Color(0xFF6A6176), modifier = Modifier.padding(bottom = 10.dp))
            }
            HorizontalDivider(color = Color(0xFFE2DCEB))
            listOf("Unlimited licensed live channels", "HD streaming quality", "Premium sports content", "Football, basketball, tennis & more").forEach {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Icon(Icons.Rounded.CheckCircle, null, Modifier.size(21.dp), tint = Color(0xFF19A16A))
                    Text(it, fontSize = 13.sp, color = Ink)
                }
            }
            val subscription = vm.account.optJSONObject("subscription")
            val trial = vm.account.optJSONObject("trial")
            if (subscription?.optBoolean("active") == true) {
                Text("Your Premium membership is active", color = Color(0xFF168C5C), fontWeight = FontWeight.Bold)
                Text("Until ${formatDate(subscription.text("expiresAt"))}", color = Ink, fontSize = 12.sp)
                ActionButton("Start watching") { vm.nav("live") }
            } else {
                if (trial == null || trial.optBoolean("eligible")) ActionButton("Try 15 minutes free", gold = true, enabled = !vm.busy) { vm.startTrial() }
                else if (trial.optLong("remainingSeconds") > 0) ActionButton("View your trial", gold = true) { vm.go("trial") }
                else Text("Your Free Trial Has Expired.\nPlease Subscribe to Continue Watching.", color = Color(0xFF8E3159), fontSize = 12.sp)
                ActionButton("Subscribe now", enabled = !vm.busy) { vm.requireLogin("payment") }
            }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Rounded.Lock, null, Modifier.size(14.dp), tint = Muted)
            Text(" Secure payment with ZAAD & eDahab", color = Muted, fontSize = 11.sp)
        }
        Text("No automatic charge for your free trial. Streaming availability depends on licensed channels configured by the service.", color = Muted, fontSize = 11.sp, lineHeight = 18.sp, textAlign = TextAlign.Center)
    }
}
@Composable fun TrialScreen(vm: AppState) {
    val trial = vm.account.optJSONObject("trial")
    val expiry = trial?.text("expiresAt").orEmpty()
    var remaining by remember(expiry) { mutableLongStateOf(secondsRemaining(expiry)) }
    LaunchedEffect(expiry) {
        while (remaining > 0) { delay(1000); remaining = secondsRemaining(expiry) }
        if (vm.user != null && expiry.isNotBlank()) vm.perform { vm.refreshAccount() }
    }
    Page {
        Heading("A taste of Premium.", "15 minutes. All the excitement.")
        Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(24.dp)).background(Panel).padding(28.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(22.dp)) {
            Icon(Icons.Rounded.Timer, null, Modifier.size(48.dp), tint = Gold)
            Badge(if (remaining > 0) "TRIAL ACTIVE" else if (trial?.optBoolean("eligible") != false) "READY WHEN YOU ARE" else "TRIAL EXPIRED", if (remaining > 0) Green else Gold)
            Text("%02d:%02d".format(remaining / 60, remaining % 60), fontSize = 60.sp, fontWeight = FontWeight.ExtraBold)
            Text(if (remaining > 0) "Your time to explore." else if (trial?.optBoolean("eligible") != false) "Start your free trial to begin watching." else "Your Free Trial Has Expired.\nPlease Subscribe to Continue Watching.", textAlign = TextAlign.Center, color = Muted, lineHeight = 22.sp)
            if (remaining > 0) ActionButton("Explore live channels", gold = true) { vm.nav("live") }
            else if (trial?.optBoolean("eligible") != false) ActionButton("Start free trial", gold = true, enabled = !vm.busy) { vm.startTrial() }
            ActionButton("Subscribe for $0.50 / month") { vm.requireLogin("payment") }
        }
        Text("Trial eligibility and expiry are verified by the server. Changing this device's time does not extend access.", fontSize = 11.sp, color = Muted, lineHeight = 18.sp)
    }
}
fun secondsRemaining(expiry: String): Long = runCatching { ((Instant.parse(expiry).toEpochMilli() - System.currentTimeMillis()) / 1000).coerceAtLeast(0) }.getOrDefault(0)

@Composable fun PaymentScreen(vm: AppState) {
    var provider by rememberSaveable { mutableStateOf("zaad") }
    var phone by rememberSaveable { mutableStateOf(vm.user?.text("phone").orEmpty()) }
    if (vm.route == "success") {
        Page {
            Image(painterResource(R.drawable.trophy), "Championship trophy", Modifier.fillMaxWidth().height(230.dp).clip(RoundedCornerShape(22.dp)), contentScale = ContentScale.Crop)
            Icon(Icons.Rounded.CheckCircle, null, Modifier.size(56.dp).align(Alignment.CenterHorizontally), tint = Green)
            Text("You're in.\nLet the games begin.", fontSize = 31.sp, fontWeight = FontWeight.ExtraBold, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
            Text("Payment successful. Your subscription has been activated.", color = Muted, textAlign = TextAlign.Center)
            AppCard {
                Detail("Plan", "Sahal Premium")
                Detail("Expires", formatDate(vm.account.optJSONObject("subscription")?.text("expiresAt").orEmpty()))
                Detail("Reference", vm.payment?.text("reference", vm.payment?.text("id").orEmpty()).orEmpty())
            }
            ActionButton("Start watching", gold = true) { vm.nav("live") }
        }; return
    }
    if (vm.route == "payment-status") {
        Page {
            Heading("Check your phone.", "Approve the request in your mobile money account. Never share your PIN in this app.")
            AppCard {
                Badge(vm.payment?.text("status", "pending")?.uppercase().orEmpty())
                Detail("Amount", "$0.50 USD")
                Detail("Payment method", vm.payment?.text("provider").orEmpty())
                Detail("Transaction reference", vm.payment?.text("reference", vm.payment?.text("id").orEmpty()).orEmpty())
            }
            ActionButton("Check payment status", enabled = !vm.busy) { vm.verifyPayment() }
            Text("Your access is activated only after server-to-server payment verification.", color = Muted, fontSize = 12.sp)
            OutlinedButton(onClick = { vm.nav("home") }, Modifier.fillMaxWidth()) { Text("Return home") }
        }; return
    }
    Page {
        Heading("Your ticket to the action.", "Choose a secure mobile money payment method.")
        AppCard {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Rounded.WorkspacePremium, null, Modifier.size(33.dp), tint = Gold)
                Column(Modifier.weight(1f).padding(start = 12.dp)) { Text("Sahal Premium", fontWeight = FontWeight.Bold); Text("Monthly subscription", color = Muted, fontSize = 12.sp) }
                Text("$0.50", fontSize = 25.sp, color = Gold, fontWeight = FontWeight.Bold)
            }
        }
        Text("PAYMENT METHOD", color = Muted, fontSize = 10.sp, letterSpacing = 1.5.sp)
        listOf("zaad" to R.drawable.zaad, "edahab" to R.drawable.edahab).forEach { (id, drawable) ->
            Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(if (provider == id) Color(0xFFF7F1FF) else Color.White)
                .clickable { provider = id }.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                Image(painterResource(drawable), if (id == "zaad") "ZAAD mobile money" else "eDahab mobile money", Modifier.width(130.dp).height(53.dp), contentScale = ContentScale.Fit)
                Spacer(Modifier.weight(1f)); RadioButton(provider == id, { provider = id }, colors = RadioButtonDefaults.colors(selectedColor = Purple, unselectedColor = Muted))
            }
        }
        Field("Mobile money phone number", phone, { phone = it }, keyboard = KeyboardType.Phone, icon = Icons.Rounded.PhoneAndroid)
        AppCard { Detail("Subscription", "$0.50 USD"); Detail("Duration", "1 month"); HorizontalDivider(color = Line); Detail("Total", "$0.50 USD", Gold) }
        ActionButton("Pay $0.50", enabled = !vm.busy && phone.isNotBlank()) { vm.pay(provider, phone) }
        Text("A secure request will be sent to your phone. Provider availability is checked by the backend; payment is never simulated.", color = Muted, fontSize = 11.sp, lineHeight = 17.sp)
        TextButton(onClick = { vm.back() }, Modifier.align(Alignment.CenterHorizontally)) { Text("Cancel", color = Muted) }
    }
}
