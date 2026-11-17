// <copyright file="Adr0223SharedResolverStressTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Emit
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System
import System.Collections.Concurrent
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import System.Security.Cryptography
import System.Text
import System.Threading
import Xunit

/// ADR-0223 D5: concurrent (cref:Compilation) objects that share one (cref:ReferenceResolver).
/// The test binds and emits many compilations in parallel against one resolver, and compares
/// each result with a serial run. The inputs are the repository samples in a fixed order, so the
/// expected results are deterministic. All compilations use one assembly name. Compilations with
/// different assembly names do not share a resolver safely (#6070), so this test does not make the
/// shared-resolver contract supported.
@Collection("Adr0223SharedResolverStress")
open class Adr0223SharedResolverStressTests {
    /// Each parallel result (diagnostic IDs, spans, and messages, and the emitted image) is
    /// equal to the serial result of the same sample. The parallel pass runs first on a new
    /// resolver, so the lazy caches of the resolver are cold when the workers start.
    @Fact
    func SharedResolver_ParallelBindAndEmit_MatchesSerialRun() {
        let repoRoot = LocateRepoRoot() ?? throw InvalidOperationException("Could not locate repository root.")
        let samples = LoadSamples(repoRoot)
        Assert.NotEmpty(samples)
        let jobs = List[int32]()
        for var round = 0; round < Rounds; round++ {
            for var index = 0; index < samples.Count; index++ {
                jobs.Add(index)
            }
        }
        // A fixed seed gives the same interleaving input in each run.
        let random = Random(223)
        for var i = jobs.Count - 1; i > 0; i-- {
            let j = random.Next(i + 1)
            let swap = jobs[i]
            jobs[i] = jobs[j]
            jobs[j] = swap
        }
        let workerCount = Math.Max(MinimumWorkers, Environment.ProcessorCount)
        let parallelResults = RunParallel(samples, jobs, workerCount)
        let serialResults = RunSerial(samples)
        // The control: the samples include programs that emit and programs with errors.
        Assert.Contains(serialResults, (result string) -> result.StartsWith("emitted ", StringComparison.Ordinal))
        Assert.Contains(serialResults, (result string) -> result.Contains("GS", StringComparison.Ordinal))
        // An exception is a failure in either pass, also when both passes throw the same exception.
        let exceptions = List[string]()
        for var index = 0; index < samples.Count; index++ {
            if serialResults[index].StartsWith(ExceptionPrefix, StringComparison.Ordinal) {
                let sample = samples[index]
                exceptions.Add("${sample.Key} (serial): ${serialResults[index]}")
            }
        }
        let mismatches = List[string]()
        for var slot = 0; slot < jobs.Count; slot++ {
            let expected = serialResults[jobs[slot]]
            let actual = parallelResults[slot]
            if actual.StartsWith(ExceptionPrefix, StringComparison.Ordinal) {
                let sample = samples[jobs[slot]]
                exceptions.Add("${sample.Key} (parallel): $actual")
            }
            if !string.Equals(expected, actual, StringComparison.Ordinal) {
                let sample = samples[jobs[slot]]
                mismatches.Add("${sample.Key}:\n  serial:   $expected\n  parallel: $actual")
            }
        }
        Assert.True(exceptions.Count == 0, "The compiler threw:\n" + string.Join("\n", exceptions.Take(10)))
        Assert.True(
            mismatches.Count == 0,
            "${mismatches.Count} of ${jobs.Count} parallel compilations (workers: $workerCount) differ from the serial run:\n" +
                string.Join("\n", mismatches.Take(10))
        )
    }

    shared {
        private const Rounds int32 = 3
        private const ExceptionPrefix string = "exception "
        private const MinimumWorkers int32 = 8
        // The compiler recurses deeply on some samples. Use the stack size of the main thread.
        private const WorkerStackSize int32 = 16777216

        // The parallel pass uses a new resolver that only this pass uses.
        private func RunParallel(
            samples List[KeyValuePair[string, string]],
            jobs List[int32],
            workerCount int32
        )[]string {
            let results = [jobs.Count]string
            // Disposed only after every worker stops (ADR-0223 D5 item 2).
            using let shared = SampleReferences.CreateResolver()
            let queue = ConcurrentQueue[int32](Enumerable.Range(0, jobs.Count))
            using let start = Barrier(workerCount)
            let workers = List[Thread]()
            for var w = 0; w < workerCount; w++ {
                let worker = Thread(
                    () -> {
                        // All workers start together, so the first binds contend for the cold caches.
                        start.SignalAndWait()
                        while queue.TryDequeue(out var slot) {
                            let sample = samples[jobs[slot]]
                            results[slot] = CompileAndDescribe(sample.Key, sample.Value, shared)
                        }
                    },
                    WorkerStackSize
                )
                worker.IsBackground = true
                workers.Add(worker)
                worker.Start()
            }
            // Wait with no time limit. A worker that is still running when the resolver is disposed, or
            // when a later test collection starts, would make the results of other tests incorrect. A
            // compilation that does not stop is stopped by the time limit of the test job.
            for worker in workers {
                worker.Join()
            }
            return results
        }

        private func RunSerial(samples List[KeyValuePair[string, string]])[]string {
            let results = [samples.Count]string
            using let serial = SampleReferences.CreateResolver()
            for var index = 0; index < samples.Count; index++ {
                results[index] = CompileAndDescribe(samples[index].Key, samples[index].Value, serial)
            }
            return results
        }

        // The samples in a fixed order: the relative path and the source text.
        private func LoadSamples(repoRoot string) List[KeyValuePair[string, string]] {
            let samples = List[KeyValuePair[string, string]]()
            for folder in[]string{
                Path.Combine(repoRoot, "samples"),
                Path.Combine(repoRoot, "samples", "refactoring-baseline")
            } {
                for file in Directory.EnumerateFiles(folder, "*.gs", SearchOption.TopDirectoryOnly).OrderBy(
                    (p string) -> p,
                    StringComparer.Ordinal
                ) {
                    let name = Path.GetRelativePath(repoRoot, file).Replace(Path.DirectorySeparatorChar, '/')
                    samples.Add(KeyValuePair[string, string](name, File.ReadAllText(file)))
                }
            }
            return samples
        }

        // Describes one compilation: the diagnostics in report order, then the image hash or the
        // exception. An exception is a result, so that a crash on one worker is a mismatch.
        private func CompileAndDescribe(name string, text string, references ReferenceResolver) string {
            let builder = StringBuilder()
            try {
                let tree = SyntaxTree.Parse(SourceText.From(text, Path.GetFileName(name)))
                let compilation = Compilation(references, tree){
                    DebugInformation = DebugInformationOptions{Deterministic: true}
                }
                using let peStream = MemoryStream()
                let result = compilation.Emit(
                    peStream: peStream,
                    pdbStream: nil,
                    refStream: nil,
                    assemblyName: "GSharp.Adr0223Stress",
                    assemblyVersion: "1.0.0.0"
                )
                if result.Success {
                    builder.Append("emitted ").Append(HashImage(peStream.ToArray()))
                } else {
                    builder.Append("failed")
                }
                for diagnostic in result.Diagnostics {
                    let span = diagnostic.Location.Span
                    builder
                        .Append(" | ")
                        .Append(diagnostic.Id)
                        .Append('@')
                        .Append(span.Start)
                        .Append('+')
                        .Append(span.Length)
                        .Append(' ')
                        .Append(diagnostic.Message)
                }
            } catch (ex Exception) {
                builder.Append(ExceptionPrefix).Append(ex.GetType().FullName).Append(": ").Append(ex.Message)
            }
            return builder.ToString()
        }

        // Hashes the complete image with each copy of the MVID set to zero. The MVID is the only
        // part of a deterministic image that changes between two emits of the same input.
        private func HashImage(image[]uint8) string {
            let bytes = image.ToArray()
            using let pe = PEReader(MemoryStream(image, writable: false))
            let reader = pe.GetMetadataReader()
            let mvid = reader.GetGuid(reader.GetModuleDefinition().Mvid)
            if mvid != Guid.Empty {
                let needle = mvid.ToByteArray()
                for var i = 0; i <= bytes.Length - needle.Length; i++ {
                    var match = true
                    for var j = 0; j < needle.Length; j++ {
                        if bytes[i + j] != needle[j] {
                            match = false
                            break
                        }
                    }
                    if match {
                        for var j = 0; j < needle.Length; j++ {
                            bytes[i + j] = uint8(0)
                        }
                    }
                }
            }
            return Convert.ToHexString(SHA256.HashData(bytes))
        }

        private func LocateRepoRoot() string? {
            let configured string? = Environment.GetEnvironmentVariable(TestSource.SourceRootEnvironmentVariable)
            if !string.IsNullOrWhiteSpace(configured) {
                let root = Path.GetFullPath(configured)
                if RepositoryRootMarker.IsRoot(root) {
                    return root
                }
            }
            var dir DirectoryInfo? = DirectoryInfo(
                Path.GetDirectoryName(typeof(Adr0223SharedResolverStressTests).Assembly.Location)!!
            )
            while dir != nil {
                if RepositoryRootMarker.IsRoot(dir.FullName) {
                    return dir.FullName
                }
                dir = dir.Parent
            }
            return nil
        }
    }
}

/// The stress test runs alone. Other test classes dispose resolvers, which clears process-wide caches
/// while compilations run (ADR-0223 D5 item 2), and the workers load all cores, which disturbs timing tests.
@CollectionDefinition("Adr0223SharedResolverStress", DisableParallelization = true)
class Adr0223SharedResolverStressCollection { }
