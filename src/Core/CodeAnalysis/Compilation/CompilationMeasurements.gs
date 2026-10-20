package GSharp.Core.CodeAnalysis.Compilation

import System
import System.Collections.Concurrent
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Linq
import System.Reflection
import System.Text.Json
import System.Threading

/// Collects opt-in, request-owned compiler measurements without changing diagnostic output.
/// Process counters are inclusive deltas. Nested or overlapping spans must not be added together.
class CompilationMeasurements : IDisposable {
    private class DisabledMeasurement : IDisposable {
        func Dispose() { }
    }
    private let previous CompilationMeasurements?
    private let outputPath string?
    private let started int64 = Stopwatch.GetTimestamp()
    private let phases ConcurrentQueue[Phase] = ConcurrentQueue[Phase]()
    private let counters ConcurrentDictionary[string, int64] = ConcurrentDictionary[string, int64](
        StringComparer.Ordinal
    )
    private let active AsyncLocal[Phase?] = AsyncLocal[Phase?]()
    private let properties ConcurrentDictionary[string, string] = ConcurrentDictionary[string, string](
        StringComparer.Ordinal
    )
    private var nextId int32
    private var disposed bool

    private init(tool string, outputPath string?) {
        Tool = tool
        this.outputPath = outputPath
        previous = current.Value
        current.Value = this
    }

    prop Tool string {
        get;
    }

    /// A completed or active phase. CPU and allocation deltas cover the whole process, not only its worker.
    private class Phase : IDisposable {
        private let owner CompilationMeasurements
        private let parent Phase?
        private let started int64 = Stopwatch.GetTimestamp()
        private let cpu TimeSpan
        private let allocated int64 = GC.GetTotalAllocatedBytes(precise: false)
        private var disposed bool

        internal init(owner CompilationMeasurements, name string) {
            this.owner = owner
            parent = owner.active.Value
            Id = Interlocked.Increment(&owner.nextId)
            ParentId = parent?.Id
            Name = name
            StartMilliseconds = Stopwatch.GetElapsedTime(CompilationMeasurements.processOrigin, started)
                .TotalMilliseconds
            using let process = Process.GetCurrentProcess()
            cpu = process.TotalProcessorTime
            owner.active.Value = this
            owner.phases.Enqueue(this)
        }

        prop Id int32 {
            get;
        }
        prop ParentId int32? {
            get;
        }
        prop Name string {
            get;
        }
        prop StartMilliseconds float64 {
            get;
        }
        prop ElapsedMilliseconds float64 {
            get;
            private set;
        }
        prop ProcessCpuMilliseconds float64 {
            get;
            private set;
        }
        prop ProcessAllocatedBytes int64 {
            get;
            private set;
        }
        prop WorkingSetBytes int64 {
            get;
            private set;
        }
        prop PeakWorkingSetBytes int64 {
            get;
            private set;
        }
        prop ManagedHeapBytes int64 {
            get;
            private set;
        }

        func Dispose() {
            if disposed {
                return
            }
            disposed = true
            ElapsedMilliseconds = Stopwatch.GetElapsedTime(started).TotalMilliseconds
            ProcessAllocatedBytes = GC.GetTotalAllocatedBytes(precise: false) - allocated
            using let process = Process.GetCurrentProcess()
            ProcessCpuMilliseconds = (process.TotalProcessorTime - cpu).TotalMilliseconds
            WorkingSetBytes = process.WorkingSet64
            PeakWorkingSetBytes = process.PeakWorkingSet64
            ManagedHeapBytes = GC.GetTotalMemory(forceFullCollection: false)
            owner.active.Value = parent
        }
    }

    /// Returns a counter from this request, including zero for an absent counter.
    func GetCounter(name string) int64 -> if counters.TryGetValue(name, out var value) {
        value
    } else {
        0
    }

    /// Writes schema-versioned JSON. Spans carry their nesting and process-relative start times.
    func WriteJson(path string) {
        let report = Dictionary[string, object?](){
            ["SchemaVersion"] = 1,
            ["Tool"] = Tool,
            ["CompilerVersion"] = typeof(CompilationMeasurements).Assembly.GetName().Version?.ToString(),
            ["CompilerInformationalVersion"] = typeof(CompilationMeasurements)
                .Assembly
                .GetCustomAttribute[AssemblyInformationalVersionAttribute]()
                ?.InformationalVersion,
            ["RuntimeVersion"] = Environment.Version.ToString(),
            ["ProcessId"] = Environment.ProcessId,
            ["LogicalProcessors"] = Environment.ProcessorCount,
            ["ElapsedMilliseconds"] = Stopwatch.GetElapsedTime(started).TotalMilliseconds,
            ["RequestStartMilliseconds"] = Stopwatch.GetElapsedTime(processOrigin, started).TotalMilliseconds,
            ["TimestampFrequency"] = Stopwatch.Frequency,
            ["CounterSemantics"] = "process-inclusive; nested and overlapping deltas are not additive",
            ["Properties"] = properties,
            ["Counters"] = counters.OrderBy((pair KeyValuePair[string, int64]) -> pair.Key).ToDictionary(
                (pair KeyValuePair[string, int64]) -> pair.Key,
                (pair KeyValuePair[string, int64]) -> pair.Value
            ),
            ["Phases"] = phases.OrderBy((phase Phase) -> phase.Id).ToArray()
        }
        File.WriteAllText(path, JsonSerializer.Serialize(report, JsonSerializerOptions(){WriteIndented = true}))
    }

    func Dispose() {
        if disposed {
            return
        }
        disposed = true
        current.Value = previous
        if outputPath is {} path {
            WriteJson(path)
        }
    }

    shared {
        private let current AsyncLocal[CompilationMeasurements?] = AsyncLocal[CompilationMeasurements?]()
        private let disabled IDisposable = DisabledMeasurement()
        private let processOrigin int64 = Stopwatch.GetTimestamp()
        /// Gets whether the current request records measurements.
        prop IsEnabled bool -> current.Value != nil

        /// Starts an explicit request. Dispose it after disposing every phase.
        func Start(tool string, outputPath string? = nil) CompilationMeasurements -> CompilationMeasurements(
            tool,
            outputPath
        )

        /// Enables driver measurements only when GSHARP_MEASURE_PHASES names an output file.
        /// The optional {pid} and {id} tokens avoid collisions between processes and repeated requests.
        func StartFromEnvironment(tool string) IDisposable {
            if current.Value != nil {
                return disabled
            }
            let path = Environment.GetEnvironmentVariable("GSHARP_MEASURE_PHASES")
            if path is not{} output || string.IsNullOrWhiteSpace(output) {
                return disabled
            }
            return Start(
                tool,
                output.Replace("{pid}", Environment.ProcessId.ToString()).Replace("{id}", Guid.NewGuid().ToString("N"))
            )
        }

        /// Opens a nested phase, or returns a shared no-op when measurements are disabled.
        func BeginPhase(name string) IDisposable -> BeginPhase(name, enabled: true)

        internal func BeginPhase(name string, enabled bool) IDisposable {
            let owner = current.Value
            return if !enabled || owner == nil {
                disabled
            } else {
                cast[IDisposable](Phase(owner, name))
            }
        }

        /// Adds a request counter, or does nothing when measurements are disabled.
        func Count(name string, amount int64 = 1) {
            current
                .Value
                ?.counters
                .AddOrUpdate[int64](
                name,
                (key string, delta int64) -> delta,
                (key string, value int64, delta int64) -> value + delta,
                amount
            )
        }

        /// Records a request option or tool identity without changing diagnostics.
        func SetProperty(name string, value string) {
            if current.Value is {} owner {
                owner.properties[name] = value
            }
        }
    }
}
