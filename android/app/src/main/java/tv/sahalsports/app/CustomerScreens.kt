package tv.sahalsports.app

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
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
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.json.JSONObject
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

@Composable fun CustomerScreen(vm: AppState) {
    when (vm.route) {
        "welcome" -> WelcomeScreen(vm)
        "login" -> AuthScreen(vm)
        "register" -> AuthScreen(vm, register = true)
        "admin-login" -> AuthScreen(vm, admin = true)
        "forgot" -> ForgotScreen(vm)
        "home" -> HomeScreen(vm)
        "live", "search" -> ChannelsScreen(vm, vm.route == "search")
        "sports" -> SportsScreen(vm)
        "schedule" -> ScheduleScreen(vm)
        "subscription" -> SubscriptionScreen(vm)
        "trial" -> TrialScreen(vm)
        "payment", "payment-status", "success" -> PaymentScreen(vm)
        "profile", "history", "settings", "password", "connection", "language", "notifications", "support", "privacy", "terms", "about" -> AccountScreen(vm)
        "player" -> PlayerScreen(vm)
        else -> HomeScreen(vm)
    }
}
@Composable fun HomeScreen(vm: AppState) {
    Page {
        Spacer(Modifier.height(2.dp))
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("THE HOME OF LIVE SPORTS", color = Gold, fontSize = 10.sp, letterSpacing = 2.sp, fontWeight = FontWeight.Bold)
            Text("Hello, ${vm.user?.text("name")?.substringBefore(' ') ?: "sports fan"}.", fontSize = 27.sp, fontWeight = FontWeight.Bold, letterSpacing = (-.5).sp)
            Text("Your front row to every moment.", color = Muted, fontSize = 13.sp)
        }
        Box(Modifier.fillMaxWidth().height(225.dp).clip(RoundedCornerShape(23.dp))) {
            Image(painterResource(R.drawable.featured_match), "beIN SPORTS featured artwork", Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
            Box(Modifier.fillMaxSize().background(Brush.horizontalGradient(listOf(Ink.copy(alpha = .85f), Purple.copy(alpha = .15f)))))
            Column(Modifier.padding(20.dp).align(Alignment.BottomStart), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Badge("THE BEAUTIFUL GAME")
                Text("Every game.\nEvery emotion.", fontSize = 29.sp, lineHeight = 31.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = (-.8).sp)
                Button(onClick = { vm.nav("live") }, colors = ButtonDefaults.buttonColors(containerColor = Gold, contentColor = Ink), shape = RoundedCornerShape(10.dp)) {
                    Icon(Icons.Rounded.PlayArrow, null, Modifier.size(20.dp)); Spacer(Modifier.width(4.dp)); Text("Explore channels", fontWeight = FontWeight.Bold, fontSize = 12.sp)
                }
            }
        }
        Column {
            Section("Live channels", "View all") { vm.nav("live") }
            LazyRow(horizontalArrangement = Arrangement.spacedBy(11.dp)) {
                items(vm.channels.ifEmpty { channelPlaceholders() }.take(6)) { channel ->
                    ChannelTile(channel, Modifier.width(116.dp)) { openChannel(vm, channel) }
                }
            }
        }
        Column {
            Section("Pick your sport", "See all") { vm.nav("sports") }
            LazyRow(horizontalArrangement = Arrangement.spacedBy(19.dp)) {
                items(vm.categories.take(4)) { name -> SportButton(name) { vm.category = name; vm.nav("live") } }
            }
        }
        PremiumBanner(vm)
        Column {
            Section("Coming up", "Schedule") { vm.nav("schedule") }
            val matches = vm.bootstrap.optJSONArray("matches")?.objects().orEmpty()
            if (matches.isEmpty()) AppCard {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(13.dp)) {
                    Icon(Icons.Rounded.CalendarMonth, null, tint = Gold)
                    Column { Text("Don't miss a moment", fontWeight = FontWeight.Bold, fontSize = 14.sp)
                        Text("Upcoming matches will appear here.", color = Muted, fontSize = 12.sp) }
                }
            } else matches.take(2).forEach { MatchCard(it) }
        }
        if (vm.connectionError != null) {
            Text("Offline catalogue · connect your backend to load available channels.", color = Muted, fontSize = 11.sp)
            OutlinedButton(onClick = { vm.go("connection") }, Modifier.fillMaxWidth()) { Text("Configure connection") }
        }
    }
}
fun channelPlaceholders() = (1..3).map { json("id" to "", "name" to "beIN SPORTS $it", "category" to "Football", "quality" to "HD", "active" to false, "licensed" to false) }
fun openChannel(vm: AppState, channel: JSONObject) {
    if (!channel.optBoolean("active") || !channel.optBoolean("licensed")) vm.message = "This channel is not available yet. An administrator must configure a licensed stream."
    else vm.play(channel)
}
@Composable fun ChannelTile(channel: JSONObject, modifier: Modifier = Modifier, onClick: () -> Unit) {
    val name = channel.text("name")
    Column(modifier.clip(RoundedCornerShape(16.dp)).background(Panel).clickable(onClick = onClick).padding(12.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(channel.text("quality", "HD"), color = Muted, fontSize = 9.sp)
            Box(Modifier.size(5.dp).clip(CircleShape).background(if (channel.optBoolean("active")) Green else Muted))
        }
        Column(Modifier.fillMaxWidth().height(48.dp).clip(RoundedCornerShape(8.dp)).background(Color(0xFFF8F4FF)), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
            if (channel.text("logoUrl").startsWith("https://")) {
                coil.compose.AsyncImage(model = channel.text("logoUrl"), contentDescription = name, modifier = Modifier.fillMaxSize().padding(4.dp), contentScale = ContentScale.Fit,
                    error = painterResource(R.drawable.brand_mark))
            } else if (name.contains("bein", ignoreCase = true)) {
                Text("beIN", color = Color(0xFF5E2A8D), fontSize = 24.sp, lineHeight = 25.sp, fontWeight = FontWeight.Light, letterSpacing = (-1).sp)
                Text("SPORTS ${name.substringAfterLast(' ')}", color = Color(0xFF5E2A8D), fontSize = 9.sp, fontWeight = FontWeight.Bold)
            } else Icon(Icons.Rounded.LiveTv, null, tint = Purple)
        }
        Text(name, fontSize = 11.sp, fontWeight = FontWeight.Medium, maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
        Text(if (channel.optBoolean("active")) "AVAILABLE" else "AWAITING SETUP", color = if (channel.optBoolean("active")) Green else Muted, fontSize = 8.sp, letterSpacing = .3.sp)
    }
}
@Composable fun SportButton(name: String, onClick: () -> Unit) {
    Column(Modifier.width(64.dp).clickable(onClick = onClick), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Box(Modifier.size(55.dp).clip(CircleShape).background(Panel), contentAlignment = Alignment.Center) {
            Icon(sportIcon(name), null, Modifier.size(29.dp), tint = if (name == "Basketball") Color(0xFFFFA257) else if (name == "Tennis") Green else Gold)
        }
        Text(name, fontSize = 10.sp, color = Muted, maxLines = 1)
    }
}
@Composable fun PremiumBanner(vm: AppState) {
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(17.dp)).background(Brush.horizontalGradient(listOf(Color(0xFF402063), Color(0xFF201333))))
        .clickable { vm.go("subscription") }.padding(18.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Icon(Icons.Rounded.WorkspacePremium, null, Modifier.size(36.dp), tint = Gold)
        Column(Modifier.weight(1f)) { Text("A little price. All the action.", fontSize = 14.sp, fontWeight = FontWeight.Bold)
            Text("Go Premium · $0.50 / month", color = Gold, fontSize = 12.sp) }
        Icon(Icons.Rounded.ArrowForward, "View Premium", tint = Gold, modifier = Modifier.size(20.dp))
    }
}
@Composable fun ChannelsScreen(vm: AppState, search: Boolean) {
    var query by rememberSaveable { mutableStateOf("") }
    Page {
        Heading(if (search) "Find your channel" else "Live TV", "The biggest sports. One place to watch.")
        Field("Search channels", query, { query = it }, icon = Icons.Rounded.Search)
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            (listOf("All") + vm.categories + "beIN").forEach { FilterChip(vm.category == it, { vm.category = it }, label = { Text(it, fontSize = 12.sp) }) }
        }
        val filtered = vm.channels.ifEmpty { channelPlaceholders() }.filter {
            it.text("name").contains(query, true) && (vm.category == "All" || it.text("category") == vm.category || (vm.category == "beIN" && it.text("name").contains("bein", true)))
        }
        if (filtered.isEmpty()) EmptyState("No channels found", "Try another search or category.", Icons.Rounded.SearchOff)
        filtered.chunked(3).forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                row.forEach { channel -> ChannelTile(channel, Modifier.weight(1f)) { openChannel(vm, channel) } }
                repeat(3 - row.size) { Spacer(Modifier.weight(1f)) }
            }
        }
        if (vm.connectionError != null) EmptyState("Connect to go live", vm.connectionError!!, action = "Retry") { vm.refreshCatalogue() }
        PremiumBanner(vm)
        Text("Only officially licensed channels can be made available. Channel names shown are catalogue entries, not active broadcasts.", color = Muted, fontSize = 11.sp, lineHeight = 17.sp)
    }
}
@Composable fun SportsScreen(vm: AppState) {
    Page {
        Heading("In a league of your own.", "Follow the sports you love.")
        vm.categories.chunked(2).forEach { pair ->
            Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                pair.forEach { name ->
                    AppCard(Modifier.weight(1f).clickable { vm.category = name; vm.nav("live") }) {
                        Icon(sportIcon(name), null, Modifier.size(42.dp), tint = Gold)
                        Text(name, fontWeight = FontWeight.Bold, fontSize = 15.sp)
                        Text("Explore channels", color = Muted, fontSize = 11.sp)
                    }
                }
            }
        }
    }
}
@Composable fun ScheduleScreen(vm: AppState) {
    Page {
        Heading("The next big moment.", "Match times are shown in your local timezone.")
        val matches = vm.bootstrap.optJSONArray("matches")?.objects().orEmpty()
        if (matches.isEmpty()) EmptyState("Your matchday starts here", "No matches are scheduled yet. Published fixtures will appear automatically.", Icons.Rounded.CalendarMonth, "Refresh") { vm.refreshCatalogue() }
        else matches.forEach { MatchCard(it) }
        PremiumBanner(vm)
    }
}
@Composable fun MatchCard(match: JSONObject) {
    AppCard {
        Text(match.text("competition"), color = Gold, fontSize = 10.sp, letterSpacing = 1.sp)
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(match.text("home"), Modifier.weight(1f), fontWeight = FontWeight.Bold, fontSize = 14.sp)
            Text("VS", color = Muted, fontSize = 11.sp, modifier = Modifier.padding(horizontal = 12.dp))
            Text(match.text("away"), Modifier.weight(1f), textAlign = TextAlign.End, fontWeight = FontWeight.Bold, fontSize = 14.sp)
        }
        Text(formatDate(match.text("startsAt")), color = Muted, fontSize = 12.sp)
    }
}
fun formatDate(value: String): String = runCatching {
    DateTimeFormatter.ofPattern("dd MMM yyyy, HH:mm").withZone(ZoneId.systemDefault()).format(Instant.parse(value))
}.getOrDefault(if (value.isBlank()) "Not available" else value)
