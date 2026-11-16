package tv.sahalsports.app

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

val Ink = Color(0xFF09051A)
val Panel = Color(0xFF17102C)
val Purple = Color(0xFF8C25FA)
val Gold = Color(0xFFFFD12B)
val Muted = Color(0xFFABA2BE)
val Green = Color(0xFF45D697)
val Line = Color(0xFF302441)

@Composable fun SahalTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = darkColorScheme(primary = Purple, secondary = Gold, background = Ink, surface = Panel,
        onPrimary = Color.White, onSecondary = Ink, onSurface = Color.White, onBackground = Color.White,
        outline = Line, error = Color(0xFFFF8498)), content = content)
}
@Composable fun Page(content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 22.dp).padding(bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(18.dp), content = content)
}
@Composable fun Brand(large: Boolean = false) {
    if (large) Image(painterResource(R.drawable.brand_lockup), "Sahal Sports TV", Modifier.size(160.dp), contentScale = ContentScale.Fit)
    else Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
        Image(painterResource(R.drawable.brand_mark), null, Modifier.size(44.dp).clip(RoundedCornerShape(10.dp)))
        Column { Text("Sahal", fontSize = 22.sp, fontWeight = FontWeight.ExtraBold, lineHeight = 23.sp)
            Text("SPORTS TV", fontSize = 10.sp, color = Gold, fontWeight = FontWeight.Bold, letterSpacing = 2.sp) }
    }
}
@Composable fun Heading(title: String, subtitle: String? = null) {
    Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
        Text(title, fontSize = 27.sp, fontWeight = FontWeight.Bold, letterSpacing = (-0.6).sp)
        subtitle?.let { Text(it, color = Muted, fontSize = 13.sp, lineHeight = 20.sp) }
    }
}
@Composable fun Section(title: String, action: String? = null, onAction: () -> Unit = {}) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
        Text(title, fontSize = 18.sp, fontWeight = FontWeight.Bold)
        action?.let { TextButton(onClick = onAction) { Text(it, color = Gold, fontSize = 12.sp); Icon(Icons.Rounded.ChevronRight, null, Modifier.size(15.dp), tint = Gold) } }
    }
}
@Composable fun ActionButton(text: String, modifier: Modifier = Modifier, gold: Boolean = false, enabled: Boolean = true, onClick: () -> Unit) {
    Button(onClick = onClick, enabled = enabled, modifier = modifier.fillMaxWidth().heightIn(min = 52.dp),
        colors = ButtonDefaults.buttonColors(containerColor = if (gold) Gold else Purple, contentColor = if (gold) Ink else Color.White),
        shape = RoundedCornerShape(14.dp)) { Text(text, fontWeight = FontWeight.Bold, fontSize = 15.sp) }
}
@Composable fun AppCard(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Column(modifier.fillMaxWidth().clip(RoundedCornerShape(19.dp)).background(Panel).padding(18.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp), content = content)
}
@Composable fun Badge(text: String, color: Color = Gold) {
    Text(text, Modifier.clip(RoundedCornerShape(6.dp)).background(color.copy(alpha = 0.12f)).padding(horizontal = 9.dp, vertical = 5.dp),
        color = color, fontSize = 10.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.8.sp)
}
@Composable fun Field(label: String, value: String, onValueChange: (String) -> Unit, secret: Boolean = false,
    keyboard: KeyboardType = KeyboardType.Text, icon: ImageVector? = null, enabled: Boolean = true) {
    var visible by remember { mutableStateOf(false) }
    OutlinedTextField(value, onValueChange, Modifier.fillMaxWidth(), label = { Text(label, fontSize = 13.sp) },
        enabled = enabled, singleLine = true, shape = RoundedCornerShape(13.dp),
        visualTransformation = if (secret && !visible) PasswordVisualTransformation() else VisualTransformation.None,
        keyboardOptions = KeyboardOptions(keyboardType = if (secret) KeyboardType.Password else keyboard),
        leadingIcon = if (icon != null) ({ Icon(icon, null, Modifier.size(19.dp), tint = Muted) }) else null,
        trailingIcon = if (secret) ({ IconButton(onClick = { visible = !visible }) { Icon(if (visible) Icons.Rounded.VisibilityOff else Icons.Rounded.Visibility,
            if (visible) "Hide password" else "Show password", Modifier.size(19.dp)) } }) else null)
}
@Composable fun MenuRow(title: String, subtitle: String? = null, icon: ImageVector = Icons.Rounded.ChevronRight,
    tint: Color = Gold, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(13.dp)).clickable(onClick = onClick).padding(vertical = 13.dp, horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(13.dp)) {
        Box(Modifier.size(36.dp).clip(RoundedCornerShape(10.dp)).background(tint.copy(alpha = .1f)), contentAlignment = Alignment.Center) {
            Icon(icon, null, Modifier.size(20.dp), tint = tint)
        }
        Column(Modifier.weight(1f)) { Text(title, fontSize = 14.sp, fontWeight = FontWeight.Medium)
            subtitle?.let { Text(it, fontSize = 11.sp, color = Muted) } }
        Icon(Icons.Rounded.ChevronRight, null, Modifier.size(18.dp), tint = Muted)
    }
}
@Composable fun EmptyState(title: String, detail: String, icon: ImageVector = Icons.Rounded.WifiOff, action: String? = null, onAction: () -> Unit = {}) {
    AppCard {
        Icon(icon, null, Modifier.size(32.dp), tint = Gold)
        Text(title, fontWeight = FontWeight.Bold, fontSize = 16.sp)
        Text(detail, color = Muted, fontSize = 13.sp, lineHeight = 20.sp)
        if (action != null) OutlinedButton(onClick = onAction) { Text(action) }
    }
}
@Composable fun Detail(label: String, value: String, color: Color = Color.White) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(label, color = Muted, fontSize = 13.sp, modifier = Modifier.weight(1f))
        Text(value, fontSize = 13.sp, color = color, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f))
    }
}
fun sportIcon(name: String): ImageVector = when (name) {
    "Football" -> Icons.Rounded.SportsSoccer
    "Basketball" -> Icons.Rounded.SportsBasketball
    "Tennis" -> Icons.Rounded.SportsTennis
    "UFC" -> Icons.Rounded.SportsMma
    "Cricket" -> Icons.Rounded.SportsCricket
    else -> Icons.Rounded.Sports
}
