package tv.sahalsports.app

import android.app.Activity
import android.content.pm.ActivityInfo
import android.view.ViewGroup
import androidx.annotation.OptIn
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.PlayerView
import kotlinx.coroutines.delay
import java.net.URI

@OptIn(UnstableApi::class)
@Composable fun PlayerScreen(vm: AppState) {
    val context = LocalContext.current
    val activity = context as? Activity
    val lifecycle = LocalLifecycleOwner.current
    val source = vm.playback
    val url = source?.text("url").orEmpty()
    var fullscreen by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val safe = remember(url, vm.api.baseUrl) { isTrustedPlaybackUrl(url, vm.api.baseUrl) }
    if (!safe || url.isBlank()) {
        Page { EmptyState("Stream unavailable", "No authorized playback session is available.", action = "Back to channels") { vm.nav("live") } }
        return
    }
    val player = remember(url) {
        val headers = mapOf("Authorization" to "Bearer ${vm.api.token.orEmpty()}")
        val factory = DefaultHttpDataSource.Factory().setDefaultRequestProperties(headers).setAllowCrossProtocolRedirects(false)
        ExoPlayer.Builder(context).setMediaSourceFactory(DefaultMediaSourceFactory(factory)).build().apply {
            setMediaItem(MediaItem.Builder().setUri(url).setMimeType(source?.text("mimeType")).build())
            prepare(); playWhenReady = true
        }
    }
    DisposableEffect(player, lifecycle) {
        val listener = object : Player.Listener {
            override fun onPlayerError(exception: PlaybackException) { error = "Playback stopped. Your access may have expired or the licensed source is unavailable." }
        }
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP) player.pause() }
        player.addListener(listener); lifecycle.lifecycle.addObserver(observer)
        onDispose { lifecycle.lifecycle.removeObserver(observer); player.removeListener(listener); player.release(); activity?.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED }
    }
    LaunchedEffect(player) {
        while (true) {
            delay(5000)
            try {
                vm.refreshAccount()
                val subscribed = vm.account.optJSONObject("subscription")?.optBoolean("active") == true
                val trial = vm.account.optJSONObject("trial")?.optLong("remainingSeconds", 0) ?: 0
                val premiumChannel = vm.selectedChannel?.optBoolean("premium", true) != false
                if (premiumChannel && !subscribed && trial <= 0) {
                    player.stop(); vm.playback = null; vm.go("subscription"); vm.message = "Your access has expired. Please subscribe to continue watching."; break
                }
                if (!source?.text("expiresAt").isNullOrBlank() && secondsRemaining(source!!.text("expiresAt")) <= 15) {
                    vm.playback = vm.api.call("GET", "/channels/${vm.selectedChannel?.text("id")}/playback")
                }
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                player.pause(); error = "Playback paused because access could not be verified. Reconnect and open the channel again."; break
            }
        }
    }
    Column(Modifier.fillMaxSize().background(Ink)) {
        if (!fullscreen) Row(Modifier.fillMaxWidth().statusBarsPadding(), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = { vm.back() }) { Icon(Icons.Rounded.ArrowBack, "Back") }
            Text(vm.selectedChannel?.text("name").orEmpty(), Modifier.weight(1f))
            Badge(vm.selectedChannel?.text("quality", "HD").orEmpty())
            Spacer(Modifier.width(16.dp))
        }
        Box(if (fullscreen) Modifier.weight(1f).fillMaxWidth() else Modifier.fillMaxWidth().aspectRatio(16f / 9f)) {
            AndroidView(factory = { PlayerView(it).apply {
                this.player = player
                useController = true
                layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
                setShowBuffering(PlayerView.SHOW_BUFFERING_WHEN_PLAYING)
            } }, modifier = Modifier.fillMaxSize())
            IconButton(onClick = {
                fullscreen = !fullscreen
                activity?.requestedOrientation = if (fullscreen) ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE else ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
            }, modifier = Modifier.align(Alignment.TopEnd)) { Icon(if (fullscreen) Icons.Rounded.FullscreenExit else Icons.Rounded.Fullscreen, "Toggle fullscreen") }
        }
        if (!fullscreen) Page {
            Spacer(Modifier.height(10.dp))
            error?.let { EmptyState("Playback interrupted", it, action = "Back to channels") { vm.nav("live") } }
            Section(vm.selectedChannel?.text("name").orEmpty())
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { Badge("LICENSED STREAM", Green); Badge(vm.selectedChannel?.text("category").orEmpty()) }
            var muted by remember { mutableStateOf(false) }
            OutlinedButton(onClick = { muted = !muted; player.volume = if (muted) 0f else 1f }) {
                Icon(if (muted) Icons.Rounded.VolumeOff else Icons.Rounded.VolumeUp, null); Text(if (muted) "  Unmute" else "  Mute")
            }
            Text("Video quality adapts to your connection. Use player controls to pause, seek available content and change tracks.", color = Muted, fontSize = 12.sp)
            Section("Available channels")
            vm.channels.filter { it.optBoolean("active") && it.text("id") != vm.selectedChannel?.text("id") }.forEach { channel ->
                MenuRow(channel.text("name"), channel.text("category"), Icons.Rounded.LiveTv) { vm.back(); vm.play(channel) }
            }
        }
    }
}
