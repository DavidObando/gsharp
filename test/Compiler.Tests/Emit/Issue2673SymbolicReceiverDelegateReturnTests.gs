// <copyright file="Issue2673SymbolicReceiverDelegateReturnTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import GSharp.Compiler
import GSharp.Compiler.Tests
import System
import System.Diagnostics
import System.IO
import Xunit

/// Issue #2673: preserve symbolic delegate returns on imported generic receivers.
open class Issue2673SymbolicReceiverDelegateReturnTests {
    @Fact
    func ExactTokenBucketRateLimiter_TryAcquire_VerifiesAndRuns() {
        const source = `package Oahu.Cli.Server.Hosting

import System
import System.Collections.Concurrent

class TokenBucketRateLimiter {
    private let buckets ConcurrentDictionary[string, Bucket] = ConcurrentDictionary[string, Bucket](StringComparer.Ordinal)
    private let ratePerSecond float64
    private let burst int32

    init(ratePerSecond float64, burst int32) {
        this.ratePerSecond = ratePerSecond
        this.burst = burst
    }

    func TryAcquire(key string) bool {
        if String.IsNullOrEmpty(key) {
            return true
        }
        let bucket = this.buckets.GetOrAdd(key, (_ string) -> Bucket(this.burst))
        lock bucket {
            let now = DateTimeOffset.UtcNow
            let elapsed = (now - bucket!!.LastRefill).TotalSeconds
            if elapsed > float64(0.0) {
                bucket!!.Tokens = Math.Min(this.burst, bucket!!.Tokens + (elapsed * this.ratePerSecond))
                bucket!!.LastRefill = now
            }
            if bucket!!.Tokens < 1.0 {
                return false
            }
            bucket!!.Tokens -= 1.0
            return true
        }
    }

    private class Bucket {
        init(initialTokens int32) {
            this.Tokens = initialTokens
            this.LastRefill = DateTimeOffset.UtcNow
        }

        prop Tokens float64
        prop LastRefill DateTimeOffset
    }
}

let limiter = TokenBucketRateLimiter(0.000001, 2)
Console.WriteLine(limiter.TryAcquire(""))
Console.WriteLine(limiter.TryAcquire("key"))
Console.WriteLine(limiter.TryAcquire("key"))
Console.WriteLine(limiter.TryAcquire("key"))`
        Assert.Equal(
            "True${Environment.NewLine}True${Environment.NewLine}True${Environment.NewLine}False${Environment.NewLine}",
            CompileAndRun(source)
        )
    }

    @Fact
    func NonGenericImportedMethod_SymbolicDelegateReturn_VerifiesAndRuns() {
        const source = `package Issue2673.Control
import System
import System.Collections.Concurrent

class Item {
    var Value int32
    init(value int32) { this.Value = value }
}

let items = ConcurrentDictionary[string, Item]()
let item = items.GetOrAdd("answer", (_ string) -> Item(42))
Console.WriteLine(item!!.Value)`
        Assert.Equal("42${Environment.NewLine}", CompileAndRun(source))
    }

    @Fact
    func IncompatibleSymbolicDelegateReturn_IsRejected() {
        const source = `package Issue2673.Negative
import System.Collections.Concurrent

class Item {}

func Probe() {
    let items = ConcurrentDictionary[string, Item]()
    let item = items.GetOrAdd("wrong", (_ string) -> "not an Item")
}`
        using let stdout = StringWriter()
        using let stderr = StringWriter()
        let previousOut = Console.Out
        let previousError = Console.Error
        Console.SetOut(stdout)
        Console.SetError(stderr)
        let tempDir = Directory.CreateTempSubdirectory("gs_2673_negative_").FullName
        try {
            let sourcePath = Path.Combine(tempDir, "test.gs")
            File.WriteAllText(sourcePath, source)
            Assert.NotEqual(0, Program.Main([]string{"/target:library", "/targetframework:net10.0", sourcePath}))
        } finally {
            Console.SetOut(previousOut)
            Console.SetError(previousError)
            try {
                Directory.Delete(tempDir, recursive: true)
            } catch { }
        }
        Assert.Contains("GetOrAdd", stdout.ToString() + stderr.ToString())
    }

    shared {
        private func CompileAndRun(source string) string {
            let tempDir = Directory.CreateTempSubdirectory("gs_2673_").FullName
            try {
                let sourcePath = Path.Combine(tempDir, "test.gs")
                let outputPath = Path.Combine(tempDir, "test.dll")
                File.WriteAllText(sourcePath, source)
                using let stdout = StringWriter()
                using let stderr = StringWriter()
                let previousOut = Console.Out
                let previousError = Console.Error
                Console.SetOut(stdout)
                Console.SetError(stderr)
                var exitCode int32
                try {
                    exitCode = Program.Main(
                        []string{"/out:" + outputPath, "/target:exe", "/targetframework:net10.0", sourcePath}
                    )
                } finally {
                    Console.SetOut(previousOut)
                    Console.SetError(previousError)
                }
                Assert.True(exitCode == 0, stdout.ToString() + stderr.ToString())
                IlVerifier.Verify(outputPath)
                File.WriteAllText(Path.ChangeExtension(outputPath, "runtimeconfig.json"), `{
  "runtimeOptions": {
    "tfm": "net10.0",
    "framework": { "name": "Microsoft.NETCore.App", "version": "10.0.0" }
  }
}`)
                let startInfo = ProcessStartInfo("dotnet"){
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false
                }
                startInfo.ArgumentList.Add("exec")
                startInfo.ArgumentList.Add(outputPath)
                using let process = Process.Start(startInfo)!!
                let result = process.StandardOutput.ReadToEnd()
                let runtimeError = process.StandardError.ReadToEnd()
                process.WaitForExit()
                Assert.True(process.ExitCode == 0, runtimeError)
                return result.ReplaceLineEndings(Environment.NewLine)
            } finally {
                try {
                    Directory.Delete(tempDir, recursive: true)
                } catch { }
            }
        }
    }
}
