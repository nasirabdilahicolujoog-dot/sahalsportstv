package tv.sahalsports.app

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable fun WelcomeScreen(vm: AppState) {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).statusBarsPadding().padding(horizontal = 26.dp, vertical = 18.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Brand(); Spacer(Modifier.weight(1f)); TextButton(onClick = { vm.nav("home") }) { Text("Explore", color = Gold) }
        }
        Spacer(Modifier.height(30.dp))
        Box(Modifier.fillMaxWidth().height(245.dp).clip(RoundedCornerShape(28.dp))) {
            Image(painterResource(R.drawable.featured_match), "Sports artwork from the supplied design", Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
            Box(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(Color.Transparent, Ink))))
            Box(Modifier.align(Alignment.BottomStart).padding(18.dp)) { Badge("ONE APP. ALL THE ACTION.") }
        }
        Spacer(Modifier.height(15.dp))
        Text("Your front row.\nEvery game.", fontSize = 36.sp, lineHeight = 40.sp, fontWeight = FontWeight.ExtraBold, textAlign = TextAlign.Center, letterSpacing = (-1).sp)
        Spacer(Modifier.height(15.dp))
        Text("Watch Live Sports, Anytime, Anywhere", color = Muted, fontSize = 14.sp, textAlign = TextAlign.Center)
        Spacer(Modifier.height(25.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) { Badge("HD STREAMING"); Badge("15 MIN FREE", Green) }
        Spacer(Modifier.height(25.dp))
        ActionButton("Login", enabled = !vm.busy) { vm.go("login") }
        Spacer(Modifier.height(12.dp))
        OutlinedButton(onClick = { vm.go("register") }, Modifier.fillMaxWidth().height(52.dp), shape = RoundedCornerShape(14.dp)) { Text("Create an account", color = Color.White) }
        Spacer(Modifier.height(18.dp))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
            TextButton(onClick = { vm.go("language") }) { Icon(Icons.Rounded.Language, null, Modifier.size(16.dp)); Spacer(Modifier.width(6.dp)); Text("English", fontSize = 12.sp) }
            TextButton(onClick = { vm.go("admin-login") }) { Icon(Icons.Rounded.AdminPanelSettings, null, Modifier.size(16.dp)); Spacer(Modifier.width(6.dp)); Text("Admin access", fontSize = 12.sp) }
        }
        TextButton(onClick = { vm.go("connection") }) { Text("Backend connection", color = Muted, fontSize = 11.sp) }
    }
}

@Composable fun AuthScreen(vm: AppState, register: Boolean = false, admin: Boolean = false) {
    var name by rememberSaveable { mutableStateOf("") }
    var phone by rememberSaveable { mutableStateOf("") }
    var email by rememberSaveable { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var confirmation by remember { mutableStateOf("") }
    var remember by rememberSaveable { mutableStateOf(true) }
    var agree by rememberSaveable { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).statusBarsPadding().imePadding().padding(horizontal = 26.dp).padding(bottom = 28.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = { vm.back() }) { Icon(Icons.Rounded.ArrowBack, "Back") }
            Spacer(Modifier.weight(1f)); Badge(if (admin) "ADMIN PORTAL" else "WELCOME TO SAHAL")
        }
        Brand(large = true)
        Heading(if (register) "Join the action." else if (admin) "Admin sign in" else "Welcome back.",
            if (register) "Your next favourite sporting moment starts here." else if (admin) "Secure, server-verified administrator access." else "The best seat in the house is yours.")
        if (!admin) SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
            SegmentedButton(selected = !register, onClick = { vm.nav("login") }, shape = SegmentedButtonDefaults.itemShape(0, 2)) { Text("Login") }
            SegmentedButton(selected = register, onClick = { vm.nav("register") }, shape = SegmentedButtonDefaults.itemShape(1, 2)) { Text("Register") }
        }
        if (register) {
            Field("Full name", name, { name = it }, icon = Icons.Rounded.PersonOutline)
            Field("Phone number (with country code)", phone, { phone = it }, keyboard = KeyboardType.Phone, icon = Icons.Rounded.PhoneAndroid)
        }
        Field(if (register) "Email address" else if (admin) "Admin email or phone" else "Phone number or email", email, { email = it }, keyboard = KeyboardType.Email,
            icon = if (admin) Icons.Rounded.AdminPanelSettings else Icons.Rounded.AlternateEmail)
        Field("Password", password, { password = it }, secret = true, icon = Icons.Rounded.Lock)
        if (register) {
            Text("Use at least 12 characters.", fontSize = 11.sp, color = Muted, modifier = Modifier.align(Alignment.Start))
            Field("Confirm password", confirmation, { confirmation = it }, secret = true, icon = Icons.Rounded.Lock)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Checkbox(agree, { agree = it }); Text("I agree to the ", fontSize = 12.sp)
                Text("Terms & Conditions", Modifier.clickable { vm.go("terms") }, color = Gold, fontSize = 12.sp)
            }
        } else Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Checkbox(remember, { remember = it }); Text("Remember me", fontSize = 12.sp)
            Spacer(Modifier.weight(1f)); TextButton(onClick = { vm.go("forgot") }) { Text("Forgot password?", fontSize = 11.sp, color = Gold) }
        }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 12.sp) }
        ActionButton(if (register) "Create account" else if (admin) "Secure login" else "Login", gold = admin, enabled = !vm.busy) {
            error = when {
                email.isBlank() || password.isBlank() -> "Enter your sign-in details."
                register && (name.isBlank() || phone.isBlank()) -> "Enter your name and phone number."
                register && !android.util.Patterns.EMAIL_ADDRESS.matcher(email.trim()).matches() -> "Enter a valid email address."
                register && password.length < 12 -> "Use a password with at least 12 characters."
                register && password != confirmation -> "Passwords do not match."
                register && !agree -> "Please agree to the Terms & Conditions."
                else -> null
            }
            if (error == null) {
                if (register) vm.register(name, phone, email, password)
                else vm.login(email, password, remember, admin)
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Rounded.VerifiedUser, null, Modifier.size(14.dp), tint = Muted)
            Text("Your account. Secure by design.", color = Muted, fontSize = 11.sp)
        }
    }
}

@Composable fun ForgotScreen(vm: AppState) {
    var email by rememberSaveable { mutableStateOf("") }
    Page {
        Spacer(Modifier.height(30.dp)); Brand(large = true)
        Heading("Forgot password?", "Enter your registered email to request a secure password reset.")
        Field("Email address", email, { email = it }, keyboard = KeyboardType.Email, icon = Icons.Rounded.AlternateEmail)
        ActionButton("Request reset", enabled = !vm.busy && email.isNotBlank()) {
            vm.perform {
                val result = vm.api.call("POST", "/auth/reset-password", json("email" to email.trim()))
                vm.message = result.text("message", "Your reset request has been received.")
            }
        }
        TextButton(onClick = { vm.back() }) { Text("Back to login") }
    }
}
