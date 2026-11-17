package tv.sahalsports.app

import android.net.Uri
import androidx.compose.foundation.clickable
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.sp
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import org.json.JSONArray
import org.json.JSONObject
import java.net.URI
import java.util.Locale

/** Content only: the application owns navigation chrome and the snackbar host. */
@Composable
fun AdminScreen(vm: AppState) {
    if (!vm.isAdmin) {
        Page {
            Heading("Administrator access")
            EmptyState("Access restricted", "Sign in with an administrator account to manage this service.")
            ActionButton("Go to sign in", enabled = !vm.busy) { vm.nav("login") }
        }
        return
    }
    key(vm.route) {
        val path = vm.route.substringBefore('?').trimEnd('/')
        when {
            path == "admin" || path == "admin/dashboard" -> AdminDashboard(vm)
            path == "admin/streams" -> AdminChannels(vm, category = Uri.parse(vm.route).getQueryParameter("category"))
            path == "admin/bein" -> AdminChannels(vm, beinOnly = true)
            path == "admin/categories" -> AdminCategories(vm)
            path == "admin/customers" -> AdminCustomers(vm)
            path.startsWith("admin/customers/") -> AdminCustomerDetails(vm, Uri.decode(path.removePrefix("admin/customers/")))
            path == "admin/subscriptions" -> AdminSubscriptions(vm)
            path == "admin/payments" -> AdminPayments(vm)
            path == "admin/zaad" -> AdminProvider(vm, "zaad")
            path == "admin/edahab" -> AdminProvider(vm, "edahab")
            path == "admin/trials" -> AdminTrials(vm)
            path == "admin/notifications" -> AdminNotifications(vm)
            path == "admin/ads" -> AdminAds(vm)
            path == "admin/reports" -> AdminReadOnly(vm, "Reports", "/admin/reports", "Figures and breakdowns returned by your backend. No estimates or sample data.")
            path == "admin/settings" -> AdminSettings(vm)
            path == "admin/security" -> AdminSecurity(vm)
            path == "admin/logs" -> AdminReadOnly(vm, "Activity logs", "/admin/logs", "Backend audit records. Sensitive credential fields are hidden.")
            else -> Page {
                Heading("Admin page not found")
                ActionButton("Open dashboard") { vm.nav("admin/dashboard") }
            }
        }
    }
}

private class AdminDataState {
    var data by mutableStateOf<Map<String, JSONObject>>(emptyMap())
    var errors by mutableStateOf<Map<String, String>>(emptyMap())
    var loading by mutableStateOf(true)
    var revision by mutableStateOf(0)
    fun refresh() { revision++ }
    fun enabled(vm: AppState) = !loading && !vm.busy
}

/** Reads deliberately run outside perform: loading never nests or locks a mutation. */
@Composable
private fun AdminDataPage(
    vm: AppState,
    title: String,
    subtitle: String,
    paths: List<String>,
    controls: @Composable ColumnScope.() -> Unit = {},
    content: @Composable ColumnScope.(AdminDataState) -> Unit
) {
    val state = remember(vm.route) { AdminDataState() }
    LaunchedEffect(vm.route, paths, state.revision) {
        state.loading = true
        val loaded = linkedMapOf<String, JSONObject>()
        val errors = linkedMapOf<String, String>()
        try {
            // Independent results let settings remain usable if a separate usage endpoint fails.
            for (path in paths) {
                try {
                    loaded[path] = vm.api.call("GET", path)
                } catch (e: Exception) {
                    if (e is CancellationException) throw e
                    errors[path] = e.message ?: "The server request failed. Try again."
                }
            }
            state.data = loaded
            state.errors = errors
        } finally {
            state.loading = false
        }
    }
    Page {
        Heading(title, subtitle)
        controls()
        if (state.loading) {
            LinearProgressIndicator(Modifier.fillMaxWidth(), color = Gold)
            Text("Loading from server…", color = Muted)
        }
        state.errors.forEach { (path, error) ->
            EmptyState("Could not load ${adminEndpointLabel(path)}", error)
        }
        OutlinedButton(onClick = { state.refresh() }, enabled = state.enabled(vm)) {
            Text(if (state.errors.isEmpty()) "Refresh" else "Retry failed requests")
        }
        content(state)
    }
}

private fun adminEndpointLabel(path: String) = when {
    path.startsWith("/admin/customers") -> "customers"
    path.startsWith("/admin/providers/") -> "provider settings"
    else -> path.substringAfterLast('/').substringBefore('?').replaceFirstChar { it.titlecase(Locale.ROOT) }
}

private fun adminPerform(vm: AppState, onError: (String?) -> Unit, action: suspend () -> Unit) {
    if (vm.busy) return
    onError(null)
    vm.perform {
        try {
            action()
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            onError(e.message ?: "The request failed. Please try again.")
            throw e // AppState also handles authentication failure and the shared snackbar.
        }
    }
}

@Composable
private fun AdminError(error: String?) {
    error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
}

@Composable
private fun AdminConfirm(
    vm: AppState,
    title: String,
    explanation: String,
    confirmLabel: String,
    onDismiss: () -> Unit,
    onConfirm: suspend () -> Unit
) {
    var error by remember { mutableStateOf<String?>(null) }
    AlertDialog(
        onDismissRequest = { if (!vm.busy) onDismiss() },
        title = { Text(title) },
        text = {
            Column(Modifier.heightIn(max = 360.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(explanation)
                AdminError(error)
                if (error != null) Text("If the connection was interrupted, the server may still have processed the request. Close this dialog and refresh the records before retrying a change.", color = Muted)
                if (vm.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            }
        },
        confirmButton = {
            TextButton(enabled = !vm.busy, onClick = {
                adminPerform(vm, { error = it }) { onConfirm(); onDismiss() }
            }) { Text(confirmLabel) }
        },
        dismissButton = { TextButton(enabled = !vm.busy, onClick = onDismiss) { Text(if (error == null) "Not now" else "Close") } }
    )
}

@Composable
private fun AdminCheck(label: String, detail: String, checked: Boolean, enabled: Boolean, onChange: (Boolean) -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(enabled = enabled) { onChange(!checked) },
        verticalAlignment = Alignment.CenterVertically
    ) {
        Checkbox(checked = checked, onCheckedChange = onChange, enabled = enabled)
        Column(Modifier.weight(1f)) {
            Text(label, fontWeight = FontWeight.Medium)
            Text(detail, color = Muted, style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
private fun AdminChoice(label: String, value: String, options: List<Pair<String, String>>, enabled: Boolean, onSelect: (String) -> Unit) {
    Text(label, color = Gold, fontWeight = FontWeight.Medium)
    options.forEach { (id, title) ->
        Row(Modifier.fillMaxWidth().clickable(enabled = enabled) { onSelect(id) }, verticalAlignment = Alignment.CenterVertically) {
            RadioButton(selected = value == id, onClick = { onSelect(id) }, enabled = enabled)
            Text(title, modifier = Modifier.weight(1f))
        }
    }
}

private fun adminValue(item: JSONObject, key: String): String = item.text(key).ifBlank { "Not returned" }
private fun adminId(item: JSONObject) = item.text("id")
private fun adminSegment(value: String) = Uri.encode(value)
private fun adminName(item: JSONObject): String = sequenceOf("name", "title", "email", "phone", "id")
    .map { item.text(it) }.firstOrNull { it.isNotBlank() } ?: "Record"
private fun adminLabel(key: String): String = key.replace(Regex("([a-z0-9])([A-Z])"), "$1 $2")
    .replace('_', ' ').replaceFirstChar { it.titlecase(Locale.ROOT) }
private fun adminSensitive(key: String): Boolean {
    val normalized = key.lowercase(Locale.ROOT).filter { it.isLetterOrDigit() }
    return listOf("password", "secret", "token", "apikey", "authorization", "credential", "privatekey", "cookie")
        .any { normalized.contains(it) }
}

/** Flatten unknown report/audit schemas without ever dumping raw credential-bearing JSON. */
private fun adminDetails(value: JSONObject): List<Pair<String, String>> {
    val result = mutableListOf<Pair<String, String>>()
    fun visit(label: String, item: Any?, depth: Int) {
        when {
            depth > 5 -> result.add(label to "Nested details omitted")
            item == null || item == JSONObject.NULL -> result.add(label to "Not returned")
            item is JSONObject -> {
                if (item.length() == 0) result.add(label to "No details returned")
                item.keys().asSequence().forEach { key ->
                    val next = if (label.isBlank()) adminLabel(key) else "$label · ${adminLabel(key)}"
                    if (adminSensitive(key)) result.add(next to "Hidden") else visit(next, item.opt(key), depth + 1)
                }
            }
            item is JSONArray -> {
                if (item.length() == 0) result.add(label to "No records returned")
                for (index in 0 until minOf(item.length(), 30)) visit("$label ${index + 1}", item.opt(index), depth + 1)
                if (item.length() > 30) result.add(label to "${item.length() - 30} additional nested records not displayed")
            }
            else -> result.add(label to item.toString().ifBlank { "Not provided" })
        }
    }
    visit("", value, 0)
    return result
}

@Composable
private fun AdminRecord(item: JSONObject, title: String? = null, actions: @Composable ColumnScope.() -> Unit = {}) {
    AppCard {
        title?.let { Text(it, color = Gold, fontWeight = FontWeight.Bold) }
        val details = remember(item) { adminDetails(item) }
        if (details.isEmpty()) Text("No details returned", color = Muted)
        details.forEach { (label, value) -> Detail(label, value) }
        actions()
    }
}

@Composable
private fun AdminRecords(items: List<JSONObject>, emptyTitle: String, emptyDetail: String) {
    if (items.isEmpty()) EmptyState(emptyTitle, emptyDetail)
    else items.forEachIndexed { index, item -> key("${adminId(item)}:$index") { AdminRecord(item) } }
}

@Composable
private fun AdminDashboard(vm: AppState) {
    AdminDataPage(vm, "Your control room.", "A clear view of your sports service.", listOf("/admin/dashboard")) { state ->
        state.data["/admin/dashboard"]?.let { data ->
            Badge("LIVE SERVICE OVERVIEW")
            val metrics = listOf(
                Triple("totalCustomers", "Total customers", Purple),
                Triple("activeSubscriptions", "Active subscriptions", Color(0xFF1C9978)),
                Triple("totalRevenue", "Revenue · ${vm.currency}", Color(0xFF9D32B7)),
                Triple("activeStreams", "Active streams", Color(0xFF2774C6)),
                Triple("expiredSubscriptions", "Expired subscriptions", Color(0xFF67507E)),
                Triple("todayPayments", "Today's payments", Color(0xFFAA7B20))
            )
            metrics.chunked(2).forEach { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    row.forEach { (field, label, color) ->
                        Column(Modifier.weight(1f).clip(RoundedCornerShape(17.dp))
                            .background(Brush.linearGradient(listOf(color, color.copy(alpha = .3f)))).padding(16.dp),
                            verticalArrangement = Arrangement.spacedBy(9.dp)) {
                            Text(label, fontSize = 11.sp, color = Color.White.copy(alpha = .8f))
                            Text(adminValue(data, field), fontSize = 26.sp, fontWeight = FontWeight.Bold)
                        }
                    }
                }
            }
            Section("Recent transactions")
            AdminRecords(data.optJSONArray("recentTransactions")?.objects().orEmpty(), "No transactions returned", "The dashboard response does not contain recent transaction records.")
        }
        Section("Management")
        AppCard {
            listOf(
                Triple("Streams", "Licensed channels and stream sources", "streams"),
                Triple("beIN channels", "Manage matching channels in your catalogue", "bein"),
                Triple("Categories", "Categories used by your channels", "categories"),
                Triple("Customers", "Search, review and manage accounts", "customers"),
                Triple("Subscriptions", "Cancel or manually renew access", "subscriptions"),
                Triple("Payments", "Provider verification and refund requests", "payments"),
                Triple("ZAAD", "Merchant credentials and connection test", "zaad"),
                Triple("eDahab", "Merchant credentials and connection test", "edahab"),
                Triple("Free trials", "Trial settings and recorded usage", "trials"),
                Triple("Notifications", "Send announcements and view history", "notifications"),
                Triple("Audio ads", "Upload voice advertisements for the home screen", "ads"),
                Triple("Reports", "Backend reporting data", "reports"),
                Triple("App settings", "Name, logo, contact, currency and price", "settings"),
                Triple("Security", "Change your administrator password", "security"),
                Triple("Activity logs", "Backend audit trail", "logs")
            ).forEach { (title, subtitle, route) -> MenuRow(title, subtitle) { vm.go("admin/$route") } }
        }
    }
}

@Composable
private fun AdminChannels(vm: AppState, category: String? = null, beinOnly: Boolean = false) {
    var editing by remember { mutableStateOf<JSONObject?>(null) }
    var editorOpen by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf<JSONObject?>(null) }
    var filter by remember { mutableStateOf("") }
    val title = if (beinOnly) "beIN channels" else category?.let { "$it channels" } ?: "Streams"
    AdminDataPage(vm, title, "Only distribute channels you are licensed to carry. Changes are saved to the backend.", listOf("/admin/channels")) { state ->
        state.data["/admin/channels"]?.let { data ->
            ActionButton("Add channel", gold = true, enabled = state.enabled(vm)) { editing = null; editorOpen = true }
            Field("Filter loaded channels", filter, { filter = it })
            val all = data.items()
            val channels = all.filter { channel ->
                (category == null || channel.text("category") == category) &&
                    (!beinOnly || channel.text("name").contains("bein", true) || channel.text("category").contains("bein", true)) &&
                    (filter.isBlank() || listOf("name", "category", "quality").any { channel.text(it).contains(filter, true) })
            }
            if (channels.isEmpty()) EmptyState("No matching channels", "No channels in the returned catalogue match this view. Add a licensed channel or change the filter.")
            channels.forEach { channel ->
                AppCard {
                    Text(adminName(channel), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                    Badge(if (channel.isNull("active")) "STATUS NOT RETURNED" else if (channel.optBoolean("active")) "ACTIVE" else "INACTIVE", if (channel.optBoolean("active")) Green else Muted)
                    Detail("Category", adminValue(channel, "category"))
                    Detail("Quality", adminValue(channel, "quality"))
                    Detail("Access", if (!channel.has("premium")) "Not returned" else if (channel.optBoolean("premium")) "Premium" else "Free")
                    Detail("License", if (!channel.has("licensed")) "Not returned" else if (channel.optBoolean("licensed")) "Confirmed" else "Not confirmed")
                    ActionButton("Edit channel", enabled = state.enabled(vm) && adminId(channel).isNotBlank()) { editing = channel; editorOpen = true }
                    OutlinedButton(onClick = { deleting = channel }, enabled = state.enabled(vm) && adminId(channel).isNotBlank()) { Text("Delete channel", color = MaterialTheme.colorScheme.error) }
                }
            }
        }
        if (editorOpen) {
            AdminChannelEditor(vm, editing, category, onDismiss = { editorOpen = false }) { state.refresh(); vm.refreshCatalogue() }
        }
        deleting?.let { channel ->
            AdminConfirm(vm, "Delete channel?", "Permanently remove ${adminName(channel)} from the catalogue. This cannot be undone.", "Delete", { deleting = null }) {
                vm.api.call("DELETE", "/admin/channels/${adminSegment(adminId(channel))}")
                state.refresh()
                vm.refreshCatalogue()
            }
        }
    }
}

@Composable
private fun AdminChannelEditor(vm: AppState, channel: JSONObject?, category: String?, onDismiss: () -> Unit, onSaved: () -> Unit) {
    var name by remember { mutableStateOf(channel?.text("name").orEmpty()) }
    var group by remember { mutableStateOf(channel?.text("category") ?: category.orEmpty()) }
    var quality by remember { mutableStateOf(channel?.text("quality").orEmpty()) }
    var streamUrl by remember { mutableStateOf(channel?.text("streamUrl").orEmpty()) }
    var logoUrl by remember { mutableStateOf(channel?.text("logoUrl").orEmpty()) }
    var active by remember { mutableStateOf(channel?.optBoolean("active") ?: false) }
    var premium by remember { mutableStateOf(channel?.optBoolean("premium") ?: true) }
    var licensed by remember { mutableStateOf(channel?.optBoolean("licensed") ?: false) }
    var error by remember { mutableStateOf<String?>(null) }
    AlertDialog(
        modifier = Modifier.imePadding(),
        onDismissRequest = { if (!vm.busy) onDismiss() },
        title = { Text(if (channel == null) "Add licensed channel" else "Edit channel") },
        text = {
            Column(Modifier.heightIn(max = 440.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Field("Channel name", name, { name = it }, enabled = !vm.busy)
                Field("Category", group, { group = it }, enabled = !vm.busy)
                Text("Use an existing category or enter a new one. Categories are stored on channels.", color = Muted)
                Field("Quality (for example HD)", quality, { quality = it }, enabled = !vm.busy)
                Field("Stream URL", streamUrl, { streamUrl = it }, keyboard = KeyboardType.Uri, enabled = !vm.busy)
                Field("Logo URL (optional)", logoUrl, { logoUrl = it }, keyboard = KeyboardType.Uri, enabled = !vm.busy)
                LogoUploadButton(vm) { logoUrl = it }
                AdminCheck("Active", "Make this channel available in the catalogue.", active, !vm.busy) { active = it }
                AdminCheck("Premium", "Require subscription access.", premium, !vm.busy) { premium = it }
                AdminCheck("Distribution license confirmed", "I confirm that this service has permission to distribute this stream. Required before activation.", licensed, !vm.busy) { licensed = it }
                AdminError(error)
                if (vm.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            }
        },
        confirmButton = {
            TextButton(enabled = !vm.busy, onClick = {
                error = when {
                    name.isBlank() || group.isBlank() || quality.isBlank() -> "Enter a channel name, category and quality."
                    !adminHttpUrl(streamUrl) -> "Enter a valid HTTP or HTTPS stream URL without embedded credentials."
                    logoUrl.isNotBlank() && !adminHttpUrl(logoUrl) -> "Enter a valid logo URL or leave it blank."
                    active && !licensed -> "Confirm the distribution license before activating the channel."
                    else -> null
                }
                if (error == null) adminPerform(vm, { error = it }) {
                    val payload = json("name" to name.trim(), "category" to group.trim(), "quality" to quality.trim(),
                        "streamUrl" to streamUrl.trim(), "logoUrl" to logoUrl.trim(), "active" to active, "premium" to premium, "licensed" to licensed)
                    if (channel == null) vm.api.call("POST", "/admin/channels", payload)
                    else vm.api.call("PATCH", "/admin/channels/${adminSegment(adminId(channel))}", payload)
                    onSaved()
                    onDismiss()
                }
            }) { Text("Save channel") }
        },
        dismissButton = { TextButton(enabled = !vm.busy, onClick = onDismiss) { Text("Cancel") } }
    )
}

private fun adminHttpUrl(value: String, httpsOnly: Boolean = false): Boolean = try {
    val uri = URI(value.trim())
    uri.host != null && uri.userInfo == null && (uri.scheme.equals("https", true) || (!httpsOnly && uri.scheme.equals("http", true)))
} catch (_: Exception) { false }

@Composable
private fun AdminCategories(vm: AppState) {
    AdminDataPage(vm, "Categories", "Categories come from channel records; there is no separate category-management API.", listOf("/admin/channels")) { state ->
        state.data["/admin/channels"]?.let { data ->
            val groups = data.items().groupBy { it.text("category") }.toSortedMap()
            if (groups.isEmpty()) EmptyState("No categories returned", "Add a licensed channel and assign its category to get started.")
            groups.forEach { (category, channels) ->
                AppCard {
                    Text(category.ifBlank { "Uncategorized" }, fontWeight = FontWeight.Bold)
                    Detail("Channels in returned data", channels.size.toString())
                    MenuRow("Manage these channels", "Edit each channel's category to regroup it.") {
                        vm.go("admin/streams?category=${Uri.encode(category)}")
                    }
                }
            }
            ActionButton("Manage all channels", enabled = !vm.busy) { vm.go("admin/streams") }
        }
    }
}

@Composable
private fun AdminCustomers(vm: AppState) {
    var search by remember { mutableStateOf("") }
    var submitted by remember { mutableStateOf("") }
    var pending by remember { mutableStateOf<Pair<JSONObject, String>?>(null) }
    var editing by remember { mutableStateOf<JSONObject?>(null) }
    var resetting by remember { mutableStateOf<JSONObject?>(null) }
    val endpoint = "/admin/customers?search=${Uri.encode(submitted)}"
    AdminDataPage(vm, "Customers", "Search backend customer records, edit details and manage account access.", listOf(endpoint), controls = {
        Field("Search name, email or phone", search, { search = it }, enabled = !vm.busy)
        ActionButton("Search customers", enabled = !vm.busy) { submitted = search.trim() }
    }) { state ->
        state.data[endpoint]?.let { data ->
            val items = data.items()
            if (items.isEmpty()) EmptyState("No customers returned", "Try another search term or clear the search.")
            items.forEach { customer ->
                AppCard {
                    Text(adminName(customer), fontWeight = FontWeight.Bold)
                    Badge(customer.text("status", "Status not returned"))
                    Detail("Email", adminValue(customer, "email"))
                    Detail("Phone", adminValue(customer, "phone"))
                    if (adminId(customer).isNotBlank()) {
                        ActionButton("Details & history", enabled = state.enabled(vm)) { vm.go("admin/customers/${adminSegment(adminId(customer))}") }
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            OutlinedButton(onClick = { editing = customer }, enabled = state.enabled(vm), modifier = Modifier.weight(1f)) {
                                Text("Edit details", fontSize = 12.sp)
                            }
                            OutlinedButton(onClick = { resetting = customer }, enabled = state.enabled(vm), modifier = Modifier.weight(1f)) {
                                Text("Reset password", fontSize = 12.sp)
                            }
                        }
                        AdminCustomerActions(vm, customer, state.enabled(vm)) { action -> pending = customer to action }
                    }
                }
            }
        }
        pending?.let { (customer, action) ->
            AdminCustomerConfirmation(vm, customer, action, { pending = null }) { state.refresh() }
        }
        editing?.let { customer ->
            AdminCustomerEditor(vm, customer, { editing = null }) { state.refresh() }
        }
        resetting?.let { customer ->
            AdminPasswordReset(vm, customer, { resetting = null })
        }
    }
}

@Composable
private fun AdminCustomerActions(vm: AppState, customer: JSONObject, enabled: Boolean, onAction: (String) -> Unit) {
    val status = customer.text("status").lowercase(Locale.ROOT)
    if (status != "active") OutlinedButton(onClick = { onAction("active") }, enabled = enabled) { Text("Activate account") }
    if (status != "suspended") OutlinedButton(onClick = { onAction("suspended") }, enabled = enabled) { Text("Suspend account") }
    OutlinedButton(onClick = { onAction("delete") }, enabled = enabled && adminId(customer) != vm.user?.text("id")) {
        Text("Delete customer", color = MaterialTheme.colorScheme.error)
    }
}

@Composable
private fun AdminCustomerEditor(vm: AppState, customer: JSONObject, onDismiss: () -> Unit, onSaved: () -> Unit) {
    var name by remember { mutableStateOf(customer.text("name")) }
    var email by remember { mutableStateOf(customer.text("email")) }
    var phone by remember { mutableStateOf(customer.text("phone")) }
    var status by remember { mutableStateOf(customer.text("status").ifBlank { "active" }) }
    var error by remember { mutableStateOf<String?>(null) }
    AlertDialog(
        modifier = Modifier.imePadding(),
        onDismissRequest = { if (!vm.busy) onDismiss() },
        title = { Text("Edit customer") },
        text = {
            Column(Modifier.heightIn(max = 440.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Field("Full name", name, { name = it }, enabled = !vm.busy)
                Field("Email address", email, { email = it }, keyboard = KeyboardType.Email, enabled = !vm.busy)
                Field("Phone number (with country code)", phone, { phone = it }, keyboard = KeyboardType.Phone, enabled = !vm.busy)
                AdminChoice("Account status", status, listOf("active" to "Active", "suspended" to "Suspended"), !vm.busy) { status = it }
                Text("Suspending the account signs the customer out on every device. Changing the phone number or email does not change the password.", color = Muted, fontSize = 12.sp)
                AdminError(error)
                if (vm.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            }
        },
        confirmButton = {
            TextButton(enabled = !vm.busy, onClick = {
                error = when {
                    name.trim().length < 2 -> "Enter the customer's full name."
                    !android.util.Patterns.EMAIL_ADDRESS.matcher(email.trim()).matches() -> "Enter a valid email address."
                    !Regex("^\\+?[1-9][0-9]{7,14}$").matches(phone.trim()) -> "Enter the phone number with country code, digits only."
                    else -> null
                }
                if (error == null) adminPerform(vm, { error = it }) {
                    vm.api.call("PATCH", "/admin/customers/${adminSegment(adminId(customer))}",
                        json("name" to name.trim(), "email" to email.trim(), "phone" to phone.trim(), "status" to status))
                    vm.message = "Customer details updated by the backend."
                    onSaved()
                    onDismiss()
                }
            }) { Text("Save details") }
        },
        dismissButton = { TextButton(enabled = !vm.busy, onClick = onDismiss) { Text("Cancel") } }
    )
}

@Composable
private fun AdminPasswordReset(vm: AppState, customer: JSONObject, onDismiss: () -> Unit) {
    var password by remember { mutableStateOf("") }
    var confirmation by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    AlertDialog(
        modifier = Modifier.imePadding(),
        onDismissRequest = { if (!vm.busy) onDismiss() },
        title = { Text("Reset customer password") },
        text = {
            Column(Modifier.heightIn(max = 400.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("Set a new password for ${adminName(customer)}. Existing sessions are signed out on every device. Give the new password to the customer directly; it is never shown again.", color = Muted)
                Field("New password", password, { password = it }, secret = true, enabled = !vm.busy)
                Field("Confirm new password", confirmation, { confirmation = it }, secret = true, enabled = !vm.busy)
                Text("Use at least 12 characters. The backend enforces the password policy.", color = Muted, fontSize = 12.sp)
                AdminError(error)
                if (vm.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            }
        },
        confirmButton = {
            TextButton(enabled = !vm.busy, onClick = {
                error = when {
                    password.length < 12 -> "Use a password with at least 12 characters."
                    password != confirmation -> "The passwords do not match."
                    else -> null
                }
                if (error == null) adminPerform(vm, { error = it }) {
                    vm.api.call("POST", "/admin/customers/${adminSegment(adminId(customer))}/password", json("newPassword" to password))
                    vm.message = "Password reset. The customer was signed out on every device."
                    onDismiss()
                }
            }) { Text("Reset password") }
        },
        dismissButton = { TextButton(enabled = !vm.busy, onClick = onDismiss) { Text("Cancel") } }
    )
}

@Composable
private fun AdminCustomerConfirmation(vm: AppState, customer: JSONObject, action: String, onDismiss: () -> Unit, onDone: () -> Unit) {
    val label = when (action) { "delete" -> "Delete"; "suspended" -> "Suspend"; else -> "Activate" }
    val effect = when (action) {
        "delete" -> "This permanently deletes the customer. The backend determines how related billing records are retained. This cannot be undone."
        "suspended" -> "This will suspend account access. It does not itself issue a refund or cancel a payment."
        else -> "This restores account access. It does not itself grant a paid subscription."
    }
    AdminConfirm(vm, "$label customer?", "${adminName(customer)}\n\n$effect", label, onDismiss) {
        val endpoint = "/admin/customers/${adminSegment(adminId(customer))}"
        if (action == "delete") vm.api.call("DELETE", endpoint)
        else vm.api.call("PATCH", endpoint, json("status" to action))
        onDone()
    }
}

private fun adminBelongsTo(item: JSONObject, id: String): Boolean =
    listOf("customerId", "userId", "customer_id", "user_id").any { item.text(it) == id } ||
        listOf("customer", "user").any { item.optJSONObject(it)?.text("id") == id }

@Composable
private fun AdminCustomerDetails(vm: AppState, id: String) {
    var action by remember { mutableStateOf<String?>(null) }
    var editing by remember { mutableStateOf<JSONObject?>(null) }
    var resetting by remember { mutableStateOf<JSONObject?>(null) }
    val customersPath = "/admin/customers"
    AdminDataPage(vm, "Customer details", "History is matched by customer ID from the available backend lists, not a separate history service.",
        listOf(customersPath, "/admin/subscriptions", "/admin/payments")) { state ->
        OutlinedButton(onClick = { vm.back() }, enabled = !vm.busy) { Text("Back to customers") }
        val customer = state.data[customersPath]?.items()?.firstOrNull { adminId(it) == id }
        if (customer != null) {
            AdminRecord(customer, adminName(customer))
            AppCard {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = { editing = customer }, enabled = state.enabled(vm), modifier = Modifier.weight(1f)) {
                        Text("Edit details", fontSize = 12.sp)
                    }
                    OutlinedButton(onClick = { resetting = customer }, enabled = state.enabled(vm), modifier = Modifier.weight(1f)) {
                        Text("Reset password", fontSize = 12.sp)
                    }
                }
                AdminCustomerActions(vm, customer, state.enabled(vm)) { action = it }
            }
            customer.optJSONArray("history")?.let { history ->
                Section("Account history")
                AdminRecords(history.objects(), "No account history returned", "No account-history entries are included in this record.")
            }
            action?.let { selectedAction ->
                AdminCustomerConfirmation(vm, customer, selectedAction, { action = null }) {
                    if (selectedAction == "delete") vm.nav("admin/customers") else state.refresh()
                }
            }
            editing?.let { selected -> AdminCustomerEditor(vm, selected, { editing = null }) { state.refresh() } }
            resetting?.let { selected -> AdminPasswordReset(vm, selected, { resetting = null }) }
        } else if (state.data.containsKey(customersPath)) {
            EmptyState("Customer not in returned data", "The customer may have been removed or may be outside the returned customer list. No separate customer-detail API is available.")
        }
        state.data["/admin/subscriptions"]?.let { data ->
            Section("Subscription history")
            AdminRecords(data.items().filter { adminBelongsTo(it, id) }, "No matching subscriptions returned", "Only records linked to this customer ID in the returned list can be shown.")
        }
        state.data["/admin/payments"]?.let { data ->
            Section("Payment history")
            AdminRecords(data.items().filter { adminBelongsTo(it, id) }, "No matching payments returned", "Only records linked to this customer ID in the returned list can be shown.")
        }
    }
}

@Composable
private fun AdminSubscriptions(vm: AppState) {
    var pending by remember { mutableStateOf<Pair<JSONObject, String>?>(null) }
    AdminDataPage(vm, "Subscriptions", "Subscription status comes from the server. Manual renewal does not verify a payment.", listOf("/admin/subscriptions")) { state ->
        state.data["/admin/subscriptions"]?.let { data ->
            if (data.items().isEmpty()) EmptyState("No subscriptions returned", "Subscriptions will appear here when the backend has records.")
            data.items().forEach { item ->
                AdminRecord(item) {
                    ActionButton("Manual renewal", enabled = state.enabled(vm) && adminId(item).isNotBlank()) { pending = item to "renew" }
                    OutlinedButton(onClick = { pending = item to "cancel" }, enabled = state.enabled(vm) && adminId(item).isNotBlank()) { Text("Cancel subscription") }
                }
            }
        }
        pending?.let { (item, action) ->
            val renew = action == "renew"
            AdminConfirm(vm, if (renew) "Manually renew subscription?" else "Cancel subscription?",
                "Subscription ${adminId(item)}\n\n" + if (renew) "The backend will determine the renewal period. This is an administrative access change, not proof of payment."
                else "Ask the backend to cancel this subscription. This may revoke access and does not issue a refund.",
                if (renew) "Renew" else "Cancel subscription", { pending = null }) {
                vm.api.call("PATCH", "/admin/subscriptions/${adminSegment(adminId(item))}", json("action" to action))
                state.refresh()
            }
        }
    }
}

@Composable
private fun AdminPayments(vm: AppState) {
    var pending by remember { mutableStateOf<Pair<JSONObject, String>?>(null) }
    var outcome by remember { mutableStateOf<JSONObject?>(null) }
    var outcomeLabel by remember { mutableStateOf("") }
    AdminDataPage(vm, "Payments", "Only the provider can confirm payment or refund status. No local status overrides.", listOf("/admin/payments")) { state ->
        outcome?.let { result ->
            Section(outcomeLabel)
            AdminPaymentResult(result)
        }
        state.data["/admin/payments"]?.let { data ->
            if (data.items().isEmpty()) EmptyState("No payments returned", "No payment records are available in this server response.")
            data.items().forEach { item ->
                AdminRecord(item) {
                    ActionButton("Verify with provider", enabled = state.enabled(vm) && adminId(item).isNotBlank()) { pending = item to "verify" }
                    OutlinedButton(onClick = { pending = item to "refund" }, enabled = state.enabled(vm) && adminId(item).isNotBlank()) { Text("Request refund", color = MaterialTheme.colorScheme.error) }
                }
            }
        }
        pending?.let { (item, action) ->
            val verify = action == "verify"
            AdminConfirm(vm, if (verify) "Verify payment?" else "Request refund?",
                "Payment ${adminId(item)}\n\n" + if (verify) "Query the configured provider for the actual payment status. Unavailable adapters return an error; this screen never marks a payment as paid."
                else "Send a real refund request to the backend and payment provider. A completed request is not proof of a completed refund. Do not retry a timed-out refund without checking its status first.",
                if (verify) "Verify" else "Request refund", { pending = null }) {
                outcome = null
                val result = vm.api.call("POST", "/admin/payments/${adminSegment(adminId(item))}/$action")
                outcomeLabel = "${if (verify) "Verification" else "Refund"} response · ${adminId(item)}"
                outcome = result
                state.refresh()
            }
        }
    }
}

@Composable
private fun AdminPaymentResult(result: JSONObject) {
    AppCard {
        Text("Backend response", color = Gold, fontWeight = FontWeight.Bold)
        val payment = result.optJSONObject("payment") ?: result
        listOf("id", "status", "provider", "amount", "currency", "refundStatus", "message").forEach { field ->
            if (payment.has(field) && !payment.isNull(field)) Detail(adminLabel(field), payment.text(field))
        }
        if (payment !== result && result.text("message").isNotBlank()) Text(result.text("message"))
        Text("Review the returned status and refreshed payment record. Request completion alone does not confirm payment or refund settlement.", color = Muted)
    }
}

@Composable
private fun AdminProvider(vm: AppState, provider: String) {
    val label = if (provider == "zaad") "ZAAD" else "eDahab"
    val endpoint = "/admin/providers/$provider"
    AdminDataPage(vm, "$label configuration", "Credentials stay on your backend. Returned API keys and secrets are never placed in the form.", listOf(endpoint)) { state ->
        state.data[endpoint]?.let { data ->
            key(data) { AdminProviderForm(vm, provider, data, state) }
        }
    }
}

private fun adminLooksMasked(value: String): Boolean = value.any { it == '*' || it == '•' || it == '●' } ||
    value.trim().lowercase(Locale.ROOT) in listOf("masked", "hidden", "redacted", "[redacted]", "[hidden]", "********")

@Composable
private fun AdminProviderForm(vm: AppState, provider: String, data: JSONObject, state: AdminDataState) {
    var merchantId by remember { mutableStateOf(data.text("merchantId")) }
    var apiUrl by remember { mutableStateOf(data.text("apiUrl")) }
    // Intentionally do not read apiKey or secretKey from a GET response, even when not masked.
    var apiKey by remember { mutableStateOf("") }
    var secretKey by remember { mutableStateOf("") }
    var environment by remember { mutableStateOf(data.text("environment").ifBlank { "sandbox" }) }
    var error by remember { mutableStateOf<String?>(null) }
    var saved by remember { mutableStateOf(false) }
    var testOpen by remember { mutableStateOf(false) }
    var testResult by remember { mutableStateOf<JSONObject?>(null) }
    val endpoint = "/admin/providers/$provider"
    val dirty = merchantId != data.text("merchantId") || apiUrl != data.text("apiUrl") || apiKey.isNotEmpty() || secretKey.isNotEmpty() ||
        environment != data.text("environment").ifBlank { "sandbox" }
    AppCard {
        Field("Merchant ID", merchantId, { merchantId = it; saved = false }, enabled = state.enabled(vm))
        Field("API URL (HTTPS)", apiUrl, { apiUrl = it; saved = false }, keyboard = KeyboardType.Uri, enabled = state.enabled(vm))
        Field("New API key (optional)", apiKey, { apiKey = it; saved = false }, secret = true, enabled = state.enabled(vm))
        Field("New secret key (optional)", secretKey, { secretKey = it; saved = false }, secret = true, enabled = state.enabled(vm))
        Text("Leave both credential fields blank to preserve stored values. Blank fields are omitted from the update; masks are never submitted. There is no credential-removal action here.", color = Muted)
        AdminChoice("Environment", environment, listOf("sandbox" to "Sandbox / testing", "production" to "Production / live"), state.enabled(vm)) { environment = it; saved = false }
        if (environment !in listOf("sandbox", "production")) Text("Server environment: $environment. Select a supported environment before saving.", color = Muted)
        AdminError(error)
        if (saved) Text("Configuration saved by the backend.", color = Green)
        ActionButton("Save configuration", gold = true, enabled = state.enabled(vm)) {
            error = when {
                merchantId.isBlank() -> "Enter a merchant ID."
                !adminHttpUrl(apiUrl, httpsOnly = true) -> "Enter a valid HTTPS API URL without embedded credentials."
                environment !in listOf("sandbox", "production") -> "Select sandbox or production."
                adminLooksMasked(apiKey) || adminLooksMasked(secretKey) -> "Enter real replacement credentials, not masked values, or leave the fields blank."
                else -> null
            }
            if (error == null) adminPerform(vm, { error = it }) {
                val payload = json("merchantId" to merchantId.trim(), "apiUrl" to apiUrl.trim(), "environment" to environment)
                if (apiKey.isNotBlank()) payload.put("apiKey", apiKey.trim())
                if (secretKey.isNotBlank()) payload.put("secretKey", secretKey.trim())
                vm.api.call("PUT", endpoint, payload)
                apiKey = ""
                secretKey = ""
                saved = true
                testResult = null
                vm.message = "Provider configuration saved by the backend."
                state.refresh()
            }
        }
        Text("Test uses the saved configuration, not unsaved form edits. An unimplemented provider adapter returns an honest unavailable error (503).", color = Muted)
        OutlinedButton(onClick = { testOpen = true }, enabled = state.enabled(vm) && !dirty) { Text("Test saved connection") }
        if (dirty) Text("Save or discard edits before testing the saved connection.", color = Muted)
    }
    testResult?.let { result ->
        AppCard {
            Section("Connection test response")
            // Never render a generic provider object: even unexpectedly unmasked credentials stay hidden.
            if (result.has("status")) Detail("Status", adminValue(result, "status"))
            if (result.has("available")) Detail("Adapter available", adminValue(result, "available"))
            Text("The test endpoint returned a response. This does not confirm a payment, refund or live settlement.", color = Muted)
        }
    }
    if (testOpen) AdminConfirm(vm, "Test saved provider connection?", "The backend will contact the configured provider adapter. No payment will be marked successful by this screen.", "Test connection", { testOpen = false }) {
        testResult = null
        testResult = vm.api.call("POST", "$endpoint/test")
    }
}

@Composable
private fun AdminTrials(vm: AppState) {
    AdminDataPage(vm, "Free trials", "Control future trial availability and inspect recorded usage.", listOf("/admin/settings", "/admin/trials")) { state ->
        state.data["/admin/settings"]?.let { data -> key(data) { AdminTrialForm(vm, data, state) } }
        state.data["/admin/trials"]?.let { data ->
            Section("Trial usage")
            AdminRecords(data.items(), "No trial usage returned", "The backend returned no trial records. This is not an estimate of total usage.")
        }
    }
}

@Composable
private fun AdminTrialForm(vm: AppState, data: JSONObject, state: AdminDataState) {
    var enabled by remember { mutableStateOf(data.optBoolean("trialEnabled", false)) }
    var minutes by remember { mutableStateOf(data.text("trialMinutes")) }
    var error by remember { mutableStateOf<String?>(null) }
    AppCard {
        Section("Trial policy")
        if (!data.has("trialEnabled")) Text("Trial-enabled setting was not returned. Choose the intended policy before saving.", color = Muted)
        AdminCheck("Enable free trials", "Allow eligible customers to request a trial. Existing usage is not reset here.", enabled, state.enabled(vm)) { enabled = it }
        Field("Trial duration in minutes", minutes, { minutes = it }, keyboard = KeyboardType.Number, enabled = state.enabled(vm))
        AdminError(error)
        ActionButton("Save trial policy", enabled = state.enabled(vm)) {
            val duration = minutes.toIntOrNull()
            if (duration == null || duration <= 0) error = "Enter a positive whole number of minutes."
            else adminPerform(vm, { error = it }) {
                vm.api.call("PUT", "/admin/settings", json("trialEnabled" to enabled, "trialMinutes" to duration))
                vm.message = "Trial policy saved by the backend."
                state.refresh()
                vm.refreshCatalogue()
            }
        }
    }
}

@Composable
private fun AdminNotifications(vm: AppState) {
    var title by remember { mutableStateOf("") }
    var body by remember { mutableStateOf("") }
    var audience by remember { mutableStateOf("all") }
    var error by remember { mutableStateOf<String?>(null) }
    var confirm by remember { mutableStateOf(false) }
    var response by remember { mutableStateOf<JSONObject?>(null) }
    AdminDataPage(vm, "Notifications", "Send through the backend and review recorded notification history.", listOf("/admin/notifications")) { state ->
        AppCard {
            Section("New announcement")
            Field("Title", title, { title = it }, enabled = !vm.busy)
            OutlinedTextField(value = body, onValueChange = { body = it }, label = { Text("Message") },
                modifier = Modifier.fillMaxWidth(), minLines = 4, maxLines = 8, enabled = !vm.busy)
            AdminChoice("Audience", audience, listOf("all" to "All customers", "premium" to "Premium customers"), !vm.busy) { audience = it }
            AdminError(error)
            ActionButton("Review & send", gold = true, enabled = !vm.busy) {
                if (title.isBlank() || body.isBlank()) error = "Enter a title and message."
                else { error = null; confirm = true }
            }
        }
        response?.let { result ->
            AppCard {
                Badge("BACKEND RESPONSE")
                if (result.has("id")) Detail("Notification ID", adminValue(result, "id"))
                if (result.has("status")) Detail("Status", adminValue(result, "status"))
                Text("The backend accepted this request. Device delivery is not confirmed by this screen; inspect history for the recorded outcome.", color = Muted)
            }
        }
        state.data["/admin/notifications"]?.let { data ->
            Section("Notification history")
            AdminRecords(data.items(), "No notification history returned", "No announcements are included in the current backend response.")
        }
        if (confirm) AdminConfirm(vm, "Send notification?", "Audience: ${if (audience == "all") "All customers" else "Premium customers"}\n\n${title.trim()}\n\n${body.trim()}\n\nThis sends a real backend request. If a request times out, inspect history before retrying to avoid duplicates.", "Send", { confirm = false }) {
            response = null
            response = vm.api.call("POST", "/admin/notifications", json("title" to title.trim(), "body" to body.trim(), "audience" to audience))
            title = ""
            body = ""
            state.refresh()
        }
    }
}

private fun adminFileSize(bytes: Int): String = when {
    bytes >= 1024 * 1024 -> String.format(Locale.ROOT, "%.1f MB", bytes / 1048576.0)
    bytes >= 1024 -> "${bytes / 1024} KB"
    else -> "$bytes B"
}

@Composable
private fun AdminAds(vm: AppState) {
    var uploading by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf<JSONObject?>(null) }
    var actionError by remember { mutableStateOf<String?>(null) }
    AdminDataPage(vm, "Audio ads", "Upload voice advertisements. Active recordings appear on the customer home screen.", listOf("/admin/ads")) { state ->
        ActionButton("Upload audio ad", gold = true, enabled = state.enabled(vm)) { uploading = true }
        AdminError(actionError)
        state.data["/admin/ads"]?.let { data ->
            if (data.items().isEmpty()) EmptyState("No audio ads", "Upload an MP3, M4A, AAC, OGG or WAV recording up to 5 MB. Nothing is generated or sampled.")
            data.items().forEach { ad ->
                AppCard {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(adminName(ad), Modifier.weight(1f), fontWeight = FontWeight.Bold)
                        Badge(if (ad.optBoolean("active")) "ACTIVE" else "INACTIVE", if (ad.optBoolean("active")) Green else Muted)
                    }
                    Detail("Audio format", ad.text("mimeType").ifBlank { "Not returned" })
                    Detail("File size", adminFileSize(ad.optInt("sizeBytes", 0)))
                    Detail("Uploaded", formatDate(ad.text("createdAt")))
                    ActionButton(if (ad.optBoolean("active")) "Deactivate" else "Activate", enabled = state.enabled(vm)) {
                        actionError = null
                        adminPerform(vm, { actionError = it }) {
                            vm.api.call("PATCH", "/admin/ads/${adminSegment(adminId(ad))}", json("active" to !ad.optBoolean("active")))
                            state.refresh()
                            vm.refreshCatalogue()
                        }
                    }
                    OutlinedButton(onClick = { deleting = ad }, enabled = state.enabled(vm)) {
                        Text("Delete ad", color = MaterialTheme.colorScheme.error)
                    }
                }
            }
        }
        if (uploading) AdminAdEditor(vm, { uploading = false }) { state.refresh(); vm.refreshCatalogue() }
        deleting?.let { ad ->
            AdminConfirm(vm, "Delete audio ad?", "Permanently remove \"${adminName(ad)}\" from the backend. Customers will no longer receive it.", "Delete", { deleting = null }) {
                vm.api.call("DELETE", "/admin/ads/${adminSegment(adminId(ad))}")
                state.refresh()
                vm.refreshCatalogue()
            }
        }
    }
}

@Composable
private fun AdminAdEditor(vm: AppState, onDismiss: () -> Unit, onSaved: () -> Unit) {
    var title by remember { mutableStateOf("") }
    var picked by remember { mutableStateOf<AudioPick?>(null) }
    var active by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    AlertDialog(
        modifier = Modifier.imePadding(),
        onDismissRequest = { if (!vm.busy) onDismiss() },
        title = { Text("Upload audio ad") },
        text = {
            Column(Modifier.heightIn(max = 440.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Field("Ad title", title, { title = it }, enabled = !vm.busy)
                AudioAdPicker(vm, label = if (picked == null) "Choose audio file" else "Replace audio file") { picked = it }
                picked?.let { Text("${it.fileName} · ${it.mimeType}", color = Muted, fontSize = 12.sp) }
                Text("MP3, M4A, AAC, OGG or WAV up to 5 MB. The file is stored on your backend and streamed only while the ad is active.", color = Muted, fontSize = 12.sp)
                AdminCheck("Active", "Show this voice ad on the customer home screen.", active, !vm.busy) { active = it }
                AdminError(error)
                if (vm.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            }
        },
        confirmButton = {
            TextButton(enabled = !vm.busy, onClick = {
                val audio = picked
                error = when {
                    title.isBlank() -> "Enter a title for the ad."
                    audio == null -> "Choose an audio file."
                    else -> null
                }
                if (error == null && audio != null) adminPerform(vm, { error = it }) {
                    vm.api.call("POST", "/admin/ads", json("title" to title.trim(), "mimeType" to audio.mimeType,
                        "data" to audio.base64, "active" to active))
                    vm.message = "Audio ad uploaded by the backend."
                    onSaved()
                    onDismiss()
                }
            }) { Text("Upload ad") }
        },
        dismissButton = { TextButton(enabled = !vm.busy, onClick = onDismiss) { Text("Cancel") } }
    )
}

@Composable
private fun AdminReadOnly(vm: AppState, title: String, endpoint: String, description: String) {
    AdminDataPage(vm, title, description, listOf(endpoint)) { state ->
        state.data[endpoint]?.let { data ->
            if (data.has("items")) {
                val summary = JSONObject()
                data.keys().asSequence().filter { it != "items" }.forEach { summary.put(it, data.opt(it)) }
                if (summary.length() > 0) AdminRecord(summary, "Response summary")
                AdminRecords(data.items(), "No records returned", "The backend returned an empty list. No sample records have been added.")
            } else if (data.length() > 0) AdminRecord(data)
            else EmptyState("No data returned", "This endpoint did not provide report or activity data.")
        }
    }
}

@Composable
private fun AdminSettings(vm: AppState) {
    AdminDataPage(vm, "App settings", "Update the service identity, support contact, logo, currency and monthly price.", listOf("/admin/settings")) { state ->
        state.data["/admin/settings"]?.let { data -> key(data) { AdminSettingsForm(vm, data, state) } }
    }
}

private fun adminPriceMinor(value: String): Int? {
    val match = Regex("^(\\d{1,7})(?:\\.(\\d{1,2}))?$").find(value.trim()) ?: return null
    val whole = match.groupValues[1].toIntOrNull() ?: return null
    val cents = match.groupValues[2].padEnd(2, '0').toIntOrNull() ?: 0
    val minor = whole.toLong() * 100 + cents
    return if (minor in 1..100_000_000) minor.toInt() else null
}

@Composable
private fun AdminSettingsForm(vm: AppState, data: JSONObject, state: AdminDataState) {
    var name by remember { mutableStateOf(data.text("appName")) }
    var email by remember { mutableStateOf(data.text("supportEmail")) }
    var phone by remember { mutableStateOf(data.text("supportPhone")) }
    var currency by remember { mutableStateOf(data.text("currency").ifBlank { "USD" }) }
    var price by remember { mutableStateOf(formatMinor(data.optInt("priceMinor", 50))) }
    var logoUrl by remember { mutableStateOf(data.text("logoUrl")) }
    var error by remember { mutableStateOf<String?>(null) }
    AppCard {
        Section("App identity")
        Field("App name", name, { name = it }, enabled = state.enabled(vm))
        Field("App logo URL", logoUrl, { logoUrl = it }, keyboard = KeyboardType.Uri, enabled = state.enabled(vm))
        LogoUploadButton(vm, "Logo uploaded. Save app settings to apply it.") { logoUrl = it }
        Text("Upload a PNG logo up to 2 MB. The saved logo replaces the bundled mark across the app after the catalogue refreshes.", color = Muted, fontSize = 12.sp)
    }
    AppCard {
        Section("Support contact")
        Field("Support email", email, { email = it }, keyboard = KeyboardType.Email, enabled = state.enabled(vm))
        Field("Support phone / WhatsApp", phone, { phone = it }, keyboard = KeyboardType.Phone, enabled = state.enabled(vm))
        Text("Digits with country code, for example +252 63 1234567. Leave a field blank to hide that contact in the app.", color = Muted, fontSize = 12.sp)
    }
    AppCard {
        Section("Price and currency")
        Field("Currency code", currency, { currency = it }, keyboard = KeyboardType.Text, enabled = state.enabled(vm))
        Field("Monthly price", price, { price = it }, keyboard = KeyboardType.Decimal, enabled = state.enabled(vm))
        Text("Use a 3–4 letter code such as USD, EUR or SLSH. New payments charge this amount; payments already recorded keep the amount charged at the time.", color = Muted, fontSize = 12.sp)
    }
    AdminError(error)
    ActionButton("Save app settings", gold = true, enabled = state.enabled(vm)) {
        val minor = adminPriceMinor(price)
        error = when {
            name.isBlank() -> "Enter the app name."
            email.isNotBlank() && !android.util.Patterns.EMAIL_ADDRESS.matcher(email.trim()).matches() -> "Enter a valid support email address."
            phone.isNotBlank() && !Regex("^\\+?[0-9][0-9 ()-]{6,30}$").matches(phone.trim()) -> "Enter a valid support phone number."
            !Regex("^[A-Za-z]{3,4}$").matches(currency.trim()) -> "Enter a 3–4 letter currency code."
            minor == null -> "Enter the monthly price, for example 0.50."
            logoUrl.isNotBlank() && !adminHttpUrl(logoUrl, httpsOnly = true) -> "Upload a logo or enter a valid HTTPS logo URL."
            else -> null
        }
        if (error == null && minor != null) adminPerform(vm, { error = it }) {
            vm.api.call("PUT", "/admin/settings", json("appName" to name.trim(), "supportEmail" to email.trim(),
                "supportPhone" to phone.trim(), "currency" to currency.trim().uppercase(), "priceMinor" to minor,
                "logoUrl" to logoUrl.trim()))
            vm.message = "App settings saved by the backend."
            state.refresh()
            vm.refreshCatalogue()
        }
    }
    Text("Trial policy is managed separately under Free trials.", color = Muted)
    MenuRow("Free trials", "Enable trials and set the duration") { vm.go("admin/trials") }
}

@Composable
private fun AdminSecurity(vm: AppState) {
    var currentPassword by remember { mutableStateOf("") }
    var newPassword by remember { mutableStateOf("") }
    var repeatPassword by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var confirm by remember { mutableStateOf(false) }
    var completed by remember { mutableStateOf(false) }
    Page {
        Heading("Security", "Change the password of your signed-in administrator account.")
        AppCard {
            Detail("Account", vm.user?.text("email")?.ifBlank { vm.user?.text("phone").orEmpty() }.orEmpty().ifBlank { "Signed-in administrator" })
            Field("Current password", currentPassword, { currentPassword = it; completed = false }, secret = true, enabled = !vm.busy)
            Field("New password", newPassword, { newPassword = it; completed = false }, secret = true, enabled = !vm.busy)
            Field("Confirm new password", repeatPassword, { repeatPassword = it; completed = false }, secret = true, enabled = !vm.busy)
            Text("Use a unique password. The backend enforces its password policy. Passwords are not saved in screen restoration state.", color = Muted)
            AdminError(error)
            if (completed) Text("Password change confirmed by the backend.", color = Green)
            ActionButton("Change password", gold = true, enabled = !vm.busy) {
                error = when {
                    currentPassword.isBlank() || newPassword.isBlank() -> "Enter the current and new passwords."
                    newPassword != repeatPassword -> "The new passwords do not match."
                    currentPassword == newPassword -> "Choose a different new password."
                    else -> null
                }
                if (error == null) confirm = true
            }
        }
        if (confirm) AdminConfirm(vm, "Change administrator password?", "Update the password for your signed-in account. The backend may require you to sign in again. No password values are included in this confirmation.", "Change password", { confirm = false }) {
            vm.api.call("POST", "/me/password", json("currentPassword" to currentPassword, "newPassword" to newPassword))
            currentPassword = ""
            newPassword = ""
            repeatPassword = ""
            completed = true
        }
    }
}
