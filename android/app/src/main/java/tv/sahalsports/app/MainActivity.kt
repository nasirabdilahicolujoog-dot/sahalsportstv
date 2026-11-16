package tv.sahalsports.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        installSplashScreen()
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent { SahalTheme { SahalApp() } }
    }
}
data class NavItem(val title: String, val route: String, val icon: ImageVector)
val customerNav = listOf(NavItem("Home", "home", Icons.Rounded.Home), NavItem("Live TV", "live", Icons.Rounded.LiveTv),
    NavItem("Sports", "sports", Icons.Rounded.SportsSoccer), NavItem("Schedule", "schedule", Icons.Rounded.CalendarMonth),
    NavItem("Profile", "profile", Icons.Rounded.PersonOutline))
val adminNav = listOf(NavItem("Dashboard", "admin/dashboard", Icons.Rounded.SpaceDashboard), NavItem("Streams", "admin/streams", Icons.Rounded.LiveTv),
    NavItem("Customers", "admin/customers", Icons.Rounded.PeopleOutline), NavItem("Payments", "admin/payments", Icons.Rounded.AccountBalanceWallet),
    NavItem("Settings", "admin/settings", Icons.Rounded.Settings))
val adminMenu = listOf(
    "Dashboard" to "dashboard", "Live stream management" to "streams", "beIN SPORTS channels" to "bein",
    "Sports categories" to "categories", "Customer management" to "customers", "Subscriptions" to "subscriptions",
    "Payment management" to "payments", "ZAAD API settings" to "zaad", "eDahab API settings" to "edahab",
    "Free trial management" to "trials", "Notifications" to "notifications", "Reports & analytics" to "reports",
    "App settings" to "settings", "Admin security" to "security", "Activity logs" to "logs")

@OptIn(ExperimentalMaterial3Api::class)
@Composable fun SahalApp(vm: AppState = viewModel()) {
    val snackbar = remember { SnackbarHostState() }
    val drawer = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    val rootScreen = vm.route in customerNav.map { it.route }
    val admin = vm.route.startsWith("admin/") && vm.isAdmin
    val auth = vm.route in listOf("welcome", "login", "register", "admin-login", "forgot")
    BackHandler(enabled = drawer.isOpen || vm.route !in listOf("welcome", "home", "admin/dashboard")) { if (drawer.isOpen) scope.launch { drawer.close() } else vm.back() }
    LaunchedEffect(vm.message) { vm.message?.let { snackbar.showSnackbar(it); vm.message = null } }
    ModalNavigationDrawer(drawerState = drawer, gesturesEnabled = !auth, drawerContent = {
        ModalDrawerSheet(drawerContainerColor = Ink) {
            Column(Modifier.padding(22.dp)) { Brand(); Spacer(Modifier.height(12.dp)); Text(if (admin) "ADMIN WORKSPACE" else "YOUR SPORTS. YOUR WAY.", color = Gold, fontSize = 10.sp, letterSpacing = 2.sp) }
            Column(Modifier.weight(1f).then(Modifier.verticalDrawerScroll())) {
                if (admin) adminMenu.forEach { (title, destination) ->
                    NavigationDrawerItem(label = { Text(title, fontSize = 13.sp) }, selected = vm.route == "admin/$destination",
                        onClick = { vm.nav("admin/$destination"); scope.launch { drawer.close() } }, modifier = Modifier.padding(horizontal = 10.dp))
                } else {
                    (customerNav + listOf(NavItem("My subscription", "subscription", Icons.Rounded.WorkspacePremium),
                        NavItem("Payment history", "history", Icons.Rounded.ReceiptLong), NavItem("Settings", "settings", Icons.Rounded.Settings),
                        NavItem("Help & support", "support", Icons.Rounded.HelpOutline))).forEach { item ->
                        NavigationDrawerItem(label = { Text(item.title) }, icon = { Icon(item.icon, null) }, selected = vm.route == item.route,
                            onClick = { vm.nav(item.route); scope.launch { drawer.close() } }, modifier = Modifier.padding(horizontal = 10.dp))
                    }
                }
            }
            NavigationDrawerItem(label = { Text(if (vm.user == null) "Sign in" else "Log out") }, selected = false,
                icon = { Icon(Icons.Rounded.Logout, null) }, onClick = { scope.launch { drawer.close() }; if (vm.user == null) vm.go("login") else vm.logout() }, modifier = Modifier.padding(10.dp))
        }
    }) {
        Scaffold(containerColor = Ink, snackbarHost = { SnackbarHost(snackbar) },
            topBar = {
                if (!auth && vm.route != "player") {
                    Row(Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 14.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                        IconButton(onClick = { if (rootScreen || admin) scope.launch { drawer.open() } else vm.back() }) {
                            Icon(if (rootScreen || admin) Icons.Rounded.Menu else Icons.Rounded.ArrowBack, if (rootScreen || admin) "Open menu" else "Back")
                        }
                        if (rootScreen) Brand() else Text(if (admin) "Admin workspace" else screenTitle(vm.route), fontWeight = FontWeight.Bold, fontSize = 16.sp)
                        Spacer(Modifier.weight(1f))
                        if (rootScreen) {
                            IconButton(onClick = { vm.go("search") }) { Icon(Icons.Rounded.Search, "Search channels", Modifier.size(23.dp)) }
                            IconButton(onClick = { vm.go("notifications") }) { Icon(Icons.Rounded.NotificationsNone, "Notifications", Modifier.size(23.dp)) }
                        } else if (admin) Badge("ADMIN")
                    }
                }
            },
            bottomBar = {
                if (rootScreen || admin) NavigationBar(containerColor = Ink, tonalElevation = 0.dp) {
                    (if (admin) adminNav else customerNav).forEach { item ->
                        NavigationBarItem(selected = vm.route == item.route, onClick = { vm.nav(item.route) },
                            icon = { Icon(item.icon, item.title, Modifier.size(23.dp)) }, label = { Text(item.title, fontSize = 10.sp) },
                            colors = NavigationBarItemDefaults.colors(selectedIconColor = Gold, selectedTextColor = Gold,
                                indicatorColor = Purple.copy(alpha = .18f), unselectedIconColor = Muted, unselectedTextColor = Muted))
                    }
                }
            }
        ) { padding ->
            Box(Modifier.fillMaxSize().padding(padding).imePadding()) {
                when {
                    admin -> AdminScreen(vm)
                    vm.route.startsWith("admin/") -> AuthScreen(vm, admin = true)
                    else -> CustomerScreen(vm)
                }
                if (vm.busy) LinearProgressIndicator(Modifier.fillMaxWidth().align(Alignment.TopCenter), color = Gold, trackColor = Panel)
            }
        }
    }
}
@Composable private fun Modifier.verticalDrawerScroll(): Modifier = verticalScroll(rememberScrollState())
fun screenTitle(route: String) = when (route) {
    "subscription" -> "Sahal Premium"
    "payment", "payment-status" -> "Secure payment"
    "success" -> "Welcome to Premium"
    "trial" -> "Your free trial"
    "history" -> "Payment history"
    "password" -> "Account security"
    "connection" -> "Backend connection"
    else -> route.replaceFirstChar { it.uppercase() }
}
