package GSharp.Workers

import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Security.Cryptography
import System.Text

/// The private, versioned transport shared by the SDK and compiler worker.
internal shared class WorkerProtocol {
    internal const Version int32 = 3
    internal const MaxFrameBytes int32 = 16 * 1024 * 1024
    internal const MaxRequests int32 = 16
    internal const MaxRetainedBytes int64 = 256 * 1024 * 1024
    internal const MaxWorkingSetBytes int64 = 1024 * 1024 * 1024
    internal const IdleMilliseconds int32 = 60000
    internal const Accepted uint8 = 1
    internal const Stdout uint8 = 2
    internal const Stderr uint8 = 3
    internal const Completed uint8 = 4
    internal const Rejected uint8 = 5

    internal func ToolIdentity(toolPath string) string {
        let directory = Path.GetDirectoryName(Path.GetFullPath(toolPath)) ?? "."
        let parts = StringBuilder(Path.GetFileName(toolPath))
        using let hash = SHA256.Create()
        for path in Directory.GetFiles(directory).OrderBy((p string) -> p, StringComparer.Ordinal) {
            if !path.EndsWith(".dll", StringComparison.OrdinalIgnoreCase) && !path.EndsWith(
                ".json",
                StringComparison.OrdinalIgnoreCase
            ) {
                continue
            }
            using let stream = File.OpenRead(path)
            parts.Append(Path.GetFileName(path))
            parts.Append(Convert.ToBase64String(hash.ComputeHash(stream)))
        }
        return Convert.ToBase64String(hash.ComputeHash(Encoding.UTF8.GetBytes(parts.ToString())))
    }

    internal func ReadFrame(reader BinaryReader)[]uint8 {
        let length = reader.ReadInt32()
        if length < 0 || length > MaxFrameBytes {
            throw InvalidDataException("Worker frame exceeds the protocol limit.")
        }
        let bytes = reader.ReadBytes(length)
        if bytes.Length != length {
            throw EndOfStreamException("Worker frame ended early.")
        }
        return bytes
    }

    internal func WriteFrame(writer BinaryWriter, payload[]uint8) {
        if payload.Length > MaxFrameBytes {
            throw InvalidDataException("Worker frame exceeds the protocol limit.")
        }
        writer.Write(payload.Length)
        writer.Write(payload)
        writer.Flush()
    }

    internal func WriteRequest(
        writer BinaryWriter,
        identity string,
        directory string,
        arguments[]string,
        environment Dictionary[string, string],
        workerGrant int32,
        diagnosticFence string
    ) {
        using let stream = MemoryStream()
        using let payload = BinaryWriter(stream, Encoding.UTF8, leaveOpen: true)
        payload.Write(Version)
        payload.Write(identity)
        payload.Write(directory)
        payload.Write(workerGrant)
        payload.Write(diagnosticFence)
        payload.Write(arguments.Length)
        for argument in arguments {
            payload.Write(argument)
        }
        payload.Write(environment.Count)
        for entry in environment {
            payload.Write(entry.Key)
            payload.Write(entry.Value)
        }
        payload.Flush()
        WriteFrame(writer, stream.ToArray())
    }

    internal func ReadCount(reader BinaryReader) int32 {
        let count = reader.ReadInt32()
        if count < 0 || count > 65536 {
            throw InvalidDataException("Worker collection exceeds the protocol limit.")
        }
        return count
    }
}
