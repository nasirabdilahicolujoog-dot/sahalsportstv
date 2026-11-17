package tv.sahalsports.app

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream

@Composable fun LogoUploadButton(vm: AppState, successMessage: String = "Logo uploaded. Save the channel to apply it.", onUploaded: (String) -> Unit) {
    val context = LocalContext.current
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) vm.perform {
            val encoded = withContext(Dispatchers.IO) {
                val bytes = ByteArray(2 * 1024 * 1024 + 1)
                val count = context.contentResolver.openInputStream(uri)?.use { input ->
                    var total = 0
                    while (total < bytes.size) {
                        val read = input.read(bytes, total, bytes.size - total)
                        if (read < 0) break
                        total += read
                    }
                    total
                } ?: throw IllegalArgumentException("The selected image could not be opened.")
                require(count < bytes.size) { "Choose an image smaller than 2 MB." }
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeByteArray(bytes, 0, count, bounds)
                require(bounds.outWidth in 1..8192 && bounds.outHeight in 1..8192) { "Choose a valid PNG, JPEG or WebP image." }
                val options = BitmapFactory.Options().apply {
                    inSampleSize = (maxOf(bounds.outWidth, bounds.outHeight) / 512).coerceAtLeast(1)
                }
                val bitmap = BitmapFactory.decodeByteArray(bytes, 0, count, options)
                    ?: throw IllegalArgumentException("The selected image could not be decoded.")
                val output = ByteArrayOutputStream()
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)
                bitmap.recycle()
                val png = output.toByteArray()
                require(png.size <= 2 * 1024 * 1024) { "The processed logo is too large. Choose a smaller image." }
                Base64.encodeToString(png, Base64.NO_WRAP)
            }
            val result = vm.api.call("POST", "/admin/logos", json("data" to encoded, "mimeType" to "image/png"))
            val url = result.text("url")
            require(url.isNotBlank()) { "The server did not return the uploaded logo address." }
            onUploaded(url)
            vm.message = successMessage
        }
    }
    OutlinedButton(onClick = { picker.launch("image/*") }, enabled = !vm.busy) { Text("Upload image") }
}

data class AudioPick(val mimeType: String, val base64: String, val fileName: String)

private fun audioMimeType(reported: String?, fileName: String?): String? = when (reported?.lowercase()) {
    "audio/mpeg", "audio/mp3", "audio/x-mp3" -> "audio/mpeg"
    "audio/mp4", "audio/m4a", "audio/x-m4a" -> "audio/mp4"
    "audio/aac" -> "audio/aac"
    "audio/ogg", "application/ogg" -> "audio/ogg"
    "audio/wav", "audio/x-wav", "audio/wave" -> "audio/wav"
    else -> when (fileName?.substringAfterLast('.', "")?.lowercase()) {
        "mp3" -> "audio/mpeg"
        "m4a", "mp4" -> "audio/mp4"
        "aac" -> "audio/aac"
        "ogg", "oga" -> "audio/ogg"
        "wav" -> "audio/wav"
        else -> null
    }
}

@Composable fun AudioAdPicker(vm: AppState, enabled: Boolean = true, label: String = "Choose audio file", onPicked: (AudioPick) -> Unit) {
    val context = LocalContext.current
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        vm.perform {
            val picked = withContext(Dispatchers.IO) {
                val limit = 5 * 1024 * 1024
                val bytes = ByteArray(limit + 1)
                val count = context.contentResolver.openInputStream(uri)?.use { input ->
                    var total = 0
                    while (total < bytes.size) {
                        val read = input.read(bytes, total, bytes.size - total)
                        if (read < 0) break
                        total += read
                    }
                    total
                } ?: throw IllegalArgumentException("The selected audio file could not be opened.")
                require(count in 1..limit) { "Choose an audio file of at most 5 MB." }
                val name = uri.lastPathSegment?.substringAfterLast('/') ?: "ad"
                val mime = audioMimeType(context.contentResolver.getType(uri), name)
                    ?: throw IllegalArgumentException("Use an MP3, M4A, AAC, OGG or WAV audio file.")
                AudioPick(mime, Base64.encodeToString(bytes.copyOf(count), Base64.NO_WRAP), name)
            }
            onPicked(picked)
            vm.message = "Audio selected. Save the ad to upload it."
        }
    }
    OutlinedButton(onClick = { picker.launch("audio/*") }, enabled = enabled && !vm.busy) { Text(label) }
}
