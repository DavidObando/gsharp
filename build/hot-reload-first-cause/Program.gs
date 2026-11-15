import System
import System.Collections.Generic
import System.Diagnostics
import System.IO
import System.Reflection
import System.Security.Cryptography
import System.Text
import System.Text.Json
import System.Threading
import Microsoft.Build.Framework
import Microsoft.Build.Logging
import Microsoft.Diagnostics.Tracing
import Microsoft.Diagnostics.Tracing.Etlx

return Projection.Run(args)

public class ProjectionTask : ITask {
    prop BuildEngine IBuildEngine?
    prop HostObject ITaskHost?
    prop Binlog string?
    prop InitialTrace string?
    prop WatcherTrace string?
    prop InitialPid string?
    prop WatcherPid string?
    prop SummaryFile string?
    prop CertificateFile string?
    prop ExpectedProject string?
    prop SnapshotFile string?
    prop OwnershipFile string?

    func Execute() bool {
        let binlog = Binlog
        let initial = InitialTrace
        let watcher = WatcherTrace
        let initialPid = InitialPid
        let watcherPid = WatcherPid
        let summary = SummaryFile
        if binlog == nil || initial == nil || watcher == nil ||
            initialPid == nil || watcherPid == nil || summary == nil {
            return false
        }
        let arguments = []string{binlog, initial, watcher, initialPid, watcherPid, summary}
        let expected = ExpectedProject
        let snapshot = SnapshotFile
        let ownership = OwnershipFile
        var status = 0
        if expected != nil && snapshot != nil && ownership != nil {
            status = Projection.RunOwned(arguments, expected, snapshot, ownership)
        } else if expected == nil && snapshot == nil && ownership == nil {
            status = Projection.Run(arguments)
        } else {
            return false
        }
        let certificate = CertificateFile
        if certificate != nil {
            Projection.TaskCertificate(certificate, status, binlog)
        }
        return status == 0
    }
}

internal class Entry {
    var Kind int32
    var Time int64
    var Node int32 = -1
    var Project int32 = -1
    var Target int32 = -1
    var Task int32 = -1
    var Submission int32 = -1
    var ParentProject int32 = -1
    var Category int32
    var Role int32
    var Thread int32
    var Identity string = ""
    var HResult int64
    var HasHResult bool
    var FramesTruncated bool
    var Frames List[Frame] = List[Frame]()
}

internal class Frame {
    var Category int32
    var Token int32
    var Identity string = ""
    var Module string = ""
    var PdbGuid string = "00000000000000000000000000000000"
}

internal class BuildData {
    var Status int32 = 1
    var Succeeded int32 = -1
    var Finished bool
    var Started bool
    var ProjectsStarted int32
    var TargetsStarted int32
    var TasksStarted int32
    var Projects int32
    var Targets int32
    var Tasks int32
    var Errors int32
    var Cancellations int32
    var Truncated bool
    var FirstNegative int64
    var Failures List[Entry] = List[Entry]()
    var Reader ReaderState = ReaderState()
}

internal class ProcessData {
    var Status int32 = 1
    var Pid int32
    var Role int32
    var Lost int64
    var Rundown bool
    var HasStacks bool
    var Exceptions int32
    var Cancellations int32
    var Truncated bool
    var Anchor int64
    var Selected List[Entry] = List[Entry]()
    var Reader ReaderState = ReaderState()
}

internal class SafeFault {
    var Present bool
    var Identity string = ""
    var HResult int64
    var HResultPresent bool
}

internal class ReaderState {
    var Stage int32
    var Outcome int32
    var Returned bool
    var Finished bool
    var InputKnown bool
    var InputBytes int64
    var HeaderKnown bool
    var FormatVersion int32
    var MinimumReaderVersion int32
    var EventLimit int32
    var EventsSeen int32
    var NativeTruncated bool
    var LimitReached bool
    var Fault SafeFault = SafeFault()
}

internal class ReaderIdentity {
    var Kind int32
    var Known bool
    var NameIdentity string = ""
    var Hash string = ""
    var Mvid string = "00000000000000000000000000000000"
    var AssemblyMajor int32
    var AssemblyMinor int32
    var AssemblyBuild int32
    var AssemblyRevision int32
    var FileMajor int32
    var FileMinor int32
    var FileBuild int32
    var FileRevision int32
}

internal class CaptureOwnership {
    var Enabled bool
    var ExpectedProject string = ""
    var SnapshotFile string = ""
    var SnapshotCreated bool
    var SnapshotBytes int64
    var SnapshotHash string = ""
    var RootProjects int32
    var MatchingRoots int32
}

internal shared class Projection {
    func TaskCertificate(path string, exitCode int32, binlog string) {
        let probe = ReplayBuild(binlog, func (_ BuildEventArgs) {
            throw InvalidOperationException("PRIVATE_HOST_PROJECTION_CONTROL")
        })
        using let stream = MemoryStream()
        using let writer = Utf8JsonWriter(stream)
        writer.WriteStartObject()
        writer.WriteNumber("schema", 1)
        writer.WriteBoolean("task_executed", true)
        writer.WriteNumber("projection_exit", exitCode)
        writer.WriteStartArray("runtime_version")
        writer.WriteNumberValue(Environment.Version.Major)
        writer.WriteNumberValue(Environment.Version.Minor)
        writer.WriteNumberValue(Environment.Version.Build)
        writer.WriteNumberValue(Environment.Version.Revision)
        writer.WriteEndArray()
        writer.WritePropertyName("projection_control")
        WriteReader(writer, probe)
        writer.WriteStartArray("loaded")
        WriteIdentity(writer, Identify(typeof(ProjectionTask).Assembly, 0))
        for assembly in AppDomain.CurrentDomain.GetAssemblies() {
            let name = assembly.GetName().Name
            var kind = -1
            if name == "Microsoft.Build" { kind = 1 }
            if name == "Microsoft.Build.Framework" { kind = 2 }
            if name == "Microsoft.Diagnostics.Tracing.TraceEvent" { kind = 3 }
            if name == "Microsoft.Diagnostics.FastSerialization" { kind = 4 }
            if name == "Microsoft.Diagnostics.NETCore.Client" { kind = 5 }
            if name == "Microsoft.Extensions.Logging.Abstractions" { kind = 6 }
            if name == "Microsoft.Extensions.DependencyInjection.Abstractions" { kind = 7 }
            if name == "Dia2Lib" { kind = 8 }
            if name == "TraceReloggerLib" { kind = 9 }
            if name == "System.Reflection.TypeExtensions" { kind = 10 }
            if name == "Microsoft.NET.StringTools" { kind = 11 }
            if name == "MSBuild" { kind = 12 }
            if name == "Microsoft.Build.Utilities.Core" { kind = 13 }
            if kind >= 0 { WriteIdentity(writer, Identify(assembly, kind)) }
        }
        writer.WriteEndArray()
        writer.WriteEndObject()
        writer.Flush()
        let output = stream.ToArray()
        if output.Length > 32768 { throw InvalidOperationException() }
        File.WriteAllBytes(path, output)
    }

    func Run(arguments []string) int32 {
        return RunCore(arguments, CaptureOwnership())
    }

    func RunOwned(arguments []string, expected string, snapshot string, proof string) int32 {
        let capture = CaptureOwnership()
        capture.Enabled = true
        capture.ExpectedProject = Path.GetFullPath(expected)
        capture.SnapshotFile = snapshot
        let status = RunCore(arguments, capture)
        using let stream = FileStream(proof, FileMode.CreateNew)
        using let writer = Utf8JsonWriter(stream)
        writer.WriteStartObject()
        writer.WriteNumber("schema", 1)
        writer.WriteBoolean("snapshot_created", capture.SnapshotCreated)
        writer.WriteNumber("snapshot_bytes", capture.SnapshotBytes)
        writer.WriteString("snapshot_sha256", capture.SnapshotHash)
        writer.WriteNumber("root_projects", capture.RootProjects)
        writer.WriteNumber("matching_roots", capture.MatchingRoots)
        writer.WriteNumber("project_binding", capture.RootProjects == 0 ? 0 :
            capture.RootProjects == capture.MatchingRoots ? 1 : 2)
        writer.WriteBoolean("project_bound", capture.RootProjects > 0 && capture.RootProjects == capture.MatchingRoots)
        writer.WriteEndObject()
        writer.Flush()
        return status
    }

    func RunCore(arguments []string, capture CaptureOwnership) int32 {
        if arguments.Length != 6 {
            return 2
        }
        try {
            let build = ReadBuildCore(arguments[0], capture)
            let initial = ReadProcess(arguments[1], int32.Parse(arguments[3]), 1, build.FirstNegative)
            let watcher = ReadProcess(arguments[2], int32.Parse(arguments[4]), 2, build.FirstNegative)
            using let stream = MemoryStream()
            using let writer = Utf8JsonWriter(stream)
            writer.WriteStartObject()
            writer.WriteNumber("schema", 2)
            writer.WriteNumber("capture_quality", Quality(build, initial, watcher))
            writer.WriteBoolean("absence_proven", false)
            writer.WriteBoolean("cross_process_order_exact", false)
            writer.WriteStartArray("readers")
            WriteIdentity(writer, Identify(typeof(BinaryLogReplayEventSource).Assembly, 1))
            WriteIdentity(writer, Identify(typeof(BuildEventArgs).Assembly, 2))
            WriteIdentity(writer, Identify(typeof(TraceLog).Assembly, 3))
            writer.WriteEndArray()
            writer.WritePropertyName("build")
            WriteBuild(writer, build)
            writer.WriteStartArray("processes")
            WriteProcess(writer, initial)
            WriteProcess(writer, watcher)
            writer.WriteEndArray()
            writer.WriteEndObject()
            writer.Flush()
            let output = stream.ToArray()
            if output.Length > 131072 {
                return 3
            }
            File.WriteAllBytes(arguments[5], output)
            return 0
        } catch {
            return 4
        }
    }

    func ReadBuild(path string) BuildData {
        return ReadBuildCore(path, CaptureOwnership())
    }

    func ReadBuildCore(path string, capture CaptureOwnership) BuildData {
        let result = BuildData()
        let parents = Dictionary[int32, int32]()
        result.Reader = ReplayBuildCore(path, func (e BuildEventArgs) {
                let entry = Entry()
                entry.Time = e.Timestamp.ToUniversalTime().Ticks
                let context = e.BuildEventContext
                if context != nil {
                    entry.Node = context.NodeId
                    entry.Project = context.ProjectContextId
                    entry.Target = context.TargetId
                    entry.Task = context.TaskId
                    entry.Submission = context.SubmissionId
                }
                if e is BuildStartedEventArgs {
                    result.Started = true
                } else if e is TargetStartedEventArgs {
                    result.TargetsStarted++
                } else if e is TaskStartedEventArgs {
                    result.TasksStarted++
                } else if e is BuildFinishedEventArgs finished {
                    result.Finished = true
                    result.Succeeded = finished.Succeeded ? 1 : 0
                } else if e is ProjectFinishedEventArgs project {
                    result.Projects++
                    entry.Role = ProjectRole(project.ProjectFile)
                    if !project.Succeeded {
                        entry.Kind = 1
                    }
                } else if e is TargetFinishedEventArgs target {
                    result.Targets++
                    entry.Role = ProjectRole(target.ProjectFile)
                    entry.Category = NameCategory(target.TargetName)
                    entry.Identity = Opaque(target.TargetName)
                    if !target.Succeeded {
                        entry.Kind = 2
                    }
                } else if e is TaskFinishedEventArgs task {
                    result.Tasks++
                    entry.Role = ProjectRole(task.ProjectFile)
                    entry.Category = NameCategory(task.TaskName)
                    entry.Identity = Opaque(task.TaskName)
                    if !task.Succeeded {
                        entry.Kind = 3
                    }
                } else if e is BuildErrorEventArgs {
                    result.Errors++
                    entry.Kind = 4
                } else if e is BuildCanceledEventArgs {
                    result.Cancellations++
                    entry.Kind = 5
                } else if e is ProjectStartedEventArgs started {
                    result.ProjectsStarted++
                    let parent = started.ParentProjectBuildEventContext
                    if capture.Enabled && (parent == nil || parent.ProjectContextId == BuildEventContext.InvalidProjectContextId) {
                        capture.RootProjects++
                        let project = started.ProjectFile
                        if project != nil && Path.GetFullPath(project) == capture.ExpectedProject {
                            capture.MatchingRoots++
                        }
                    }
                    if parent != nil && context != nil {
                        parents[context.ProjectContextId] = parent.ProjectContextId
                    }
                }
                if entry.Kind > 0 {
                    if parents.ContainsKey(entry.Project) {
                        entry.ParentProject = parents[entry.Project]
                    }
                    if result.FirstNegative == 0 {
                        result.FirstNegative = entry.Time
                    }
                    if result.Failures.Count < 32 {
                        result.Failures.Add(entry)
                    } else {
                        result.Truncated = true
                    }
                }
        }, capture)
        result.Status = result.Reader.Outcome == 1 ? 0 :
            result.Reader.Outcome == 0 ? 1 :
            result.Reader.Outcome == 13 ? 3 : 2
        return result
    }

    func ReplayBuild(path string, observer Action[BuildEventArgs]) ReaderState {
        return ReplayBuildCore(path, observer, CaptureOwnership())
    }

    func ReplayBuildCore(path string, observer Action[BuildEventArgs], capture CaptureOwnership) ReaderState {
        let state = ReaderState()
        try {
            if !Input(path, 16777216, state) { return state }
            state.Stage = 2
            var replayPath = path
            if capture.Enabled {
                Snapshot(path, capture)
                replayPath = capture.SnapshotFile
            }
            using let file = FileStream(replayPath, FileMode.Open, FileAccess.Read, FileShare.None)
            using let input = BinaryLogReplayEventSource.OpenReader(file)
            using let reader = BinaryLogReplayEventSource.OpenBuildEventsReader(input, false, false)
            return ReplayOpened(reader, observer, state)
        } catch (error Exception) {
            state.Fault = Fault(error)
            state.Outcome = state.Stage == 1 ? 14 : (error is NotSupportedException) ? 15 : 3
            return state
        }
    }

    func Snapshot(path string, capture CaptureOwnership) {
        using let source = FileStream(path, FileMode.Open, FileAccess.Read, FileShare.None)
        let length = source.Length
        if length > 16777216 { throw InvalidOperationException() }
        using let target = FileStream(capture.SnapshotFile, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None)
        source.CopyTo(target)
        target.Flush()
        source.Position = 0
        let original = Convert.ToHexString(SHA256.HashData(source))
        target.Position = 0
        let copied = Convert.ToHexString(SHA256.HashData(target))
        if source.Length != length || target.Length != length || original != copied {
            throw InvalidOperationException()
        }
        capture.SnapshotCreated = true
        capture.SnapshotBytes = length
        capture.SnapshotHash = copied
    }

    func ReplayOpened(reader BuildEventArgsReader, observer Action[BuildEventArgs], state ReaderState) ReaderState {
        var source BinaryLogReplayEventSource? = nil
        try {
            state.Stage = 3
            source = BinaryLogReplayEventSource()
            source.AnyEventRaised += func (_ object?, e BuildEventArgs) {
                state.Stage = 4
                if e is BuildFinishedEventArgs { state.Finished = true }
                observer(e)
                state.Stage = 3
            }
            state.Stage = 3
            source.Replay(reader, CancellationToken.None)
            Header(source, state)
            state.Returned = true
            state.Outcome = state.Finished ? 1 : 2
            state.Stage = 5
        } catch (error Exception) {
            if source != nil { Header(source, state) }
            state.Fault = Fault(error)
            state.Outcome = state.Stage == 4 ? 5 : 4
        }
        return state
    }

    func Header(source BinaryLogReplayEventSource, state ReaderState) {
        try {
            state.FormatVersion = source.FileFormatVersion
            state.MinimumReaderVersion = source.MinimumReaderVersion
            state.HeaderKnown = true
        } catch (InvalidOperationException) {
            state.HeaderKnown = false
        }
    }

    func Input(path string, limit int64, state ReaderState) bool {
        state.Stage = 1
        if !File.Exists(path) { return false }
        state.InputBytes = FileInfo(path).Length
        state.InputKnown = true
        if state.InputBytes > limit {
            state.Outcome = 13
            return false
        }
        return true
    }

    func Fault(error Exception) SafeFault {
        let result = SafeFault()
        result.Present = true
        let name = error.GetType().FullName
        if name != nil { result.Identity = Opaque(name) }
        result.HResult = error.HResult
        result.HResultPresent = true
        return result
    }

    func ReadProcess(path string, pid int32, role int32, negative int64) ProcessData {
        let result = ProcessData()
        result.Pid = pid
        result.Role = role
        if pid <= 0 {
            return result
        }
        try {
            if !Input(path, 67108864, result.Reader) {
                if result.Reader.Outcome == 13 { result.Status = 3 }
                return result
            }
            result.Reader.Stage = 6
            let options = TraceLogOptions()
            options.KeepAllEvents = true
            options.ContinueOnError = false
            options.LocalSymbolsOnly = true
            options.MaxEventCount = 1000000
            options.ConversionLog = TextWriter.Null
            let converted = path + ".etlx"
            TraceLog.CreateFromEventPipeDataFile(path, converted, options)
            return ReadConverted(converted, pid, role, negative, result, options.MaxEventCount)
        } catch (error Exception) {
            TraceFailure(result.Reader, error)
            result.Status = 2
        }
        return result
    }

    func ReadConverted(path string, pid int32, role int32, negative int64, result ProcessData, eventLimit int32) ProcessData {
        try {
            result.Reader.EventLimit = eventLimit
            result.Reader.Stage = 7
            using let trace = TraceLog(path)
            result.Lost = trace.EventsLost
            result.HasStacks = trace.HasCallStacks
            result.Truncated = trace.Truncated
            result.Reader.NativeTruncated = trace.Truncated
            var anchor = negative
            ScanTrace(trace, func (e TraceEvent) {
                result.Reader.EventsSeen++
                if e.ProcessID != pid {
                    return
                }
                if e.ProviderName == "Microsoft-Windows-DotNETRuntimeRundown" &&
                    (int32(e.ID) == 145 || int32(e.ID) == 146) {
                    result.Rundown = true
                }
                if IsCancellation(e) {
                    result.Cancellations++
                    if anchor == 0 || (role == 2 && result.Cancellations == 1) {
                        anchor = e.TimeStamp.ToUniversalTime().Ticks
                    }
                    let item = TraceEntry(e, trace, 7)
                    if result.Selected.Count < 4 {
                        result.Selected.Add(item)
                    } else {
                        result.Selected[3] = item
                        result.Truncated = true
                    }
                }
                if IsException(e) {
                    result.Exceptions++
                }
            }, result.Reader)
            let before = List[Entry]()
            result.Anchor = anchor
            let after = List[Entry]()
            let priorityBefore = List[Entry]()
            let priorityAfter = List[Entry]()
            ScanTrace(trace, func (e TraceEvent) {
                if e.ProcessID != pid || !IsException(e) {
                    return
                }
                let time = e.TimeStamp.ToUniversalTime().Ticks
                let category = ExceptionCategory(e)
                let close = anchor == 0 || Math.Abs(time - anchor) <= 20000000
                if !close {
                    return
                }
                let item = TraceEntry(e, trace, 8)
                item.Category = category
                let preceding = time <= anchor || anchor == 0
                if category == 1 || category == 2 {
                    if preceding {
                        priorityBefore.Clear()
                        priorityBefore.Add(item)
                    } else if priorityAfter.Count == 0 {
                        priorityAfter.Add(item)
                    }
                } else {
                    if preceding {
                        if before.Count == 2 {
                            before.RemoveAt(0)
                        }
                        before.Add(item)
                    } else if after.Count < 2 {
                        after.Add(item)
                    }
                }
            }, result.Reader)
            result.Selected.AddRange(priorityBefore)
            result.Selected.AddRange(priorityAfter)
            result.Selected.AddRange(before)
            result.Selected.AddRange(after)
            let selectedExceptions = priorityBefore.Count + priorityAfter.Count + before.Count + after.Count
            result.Truncated = result.Truncated || result.Exceptions > selectedExceptions
            result.Status = Completeness(trace.Truncated, result.Lost, result.Rundown, result.HasStacks)
            for item in result.Selected {
                result.Truncated = result.Truncated || item.FramesTruncated
                if item.Frames.Count == 0 && result.Status == 0 {
                    result.Status = 5
                }
            }
            result.Reader.Returned = true
            result.Reader.LimitReached = eventLimit > 0 && result.Reader.EventsSeen >= eventLimit
            if result.Reader.LimitReached {
                result.Status = 2
                result.Truncated = true
            }
            result.Reader.Outcome = result.Status == 0 ? 1 :
                result.Status == 2 ? 9 :
                result.Status == 4 ? 10 :
                result.Status == 5 ? 12 : 11
            result.Reader.Stage = 5
        } catch (error Exception) {
            TraceFailure(result.Reader, error)
            result.Status = 2
        }
        return result
    }

    func ScanTrace(trace TraceLog, observer Action[TraceEvent], state ReaderState) {
        state.Stage = 8
        for e in trace.Events {
            state.Stage = 9
            observer(e)
            state.Stage = 8
        }
    }

    func TraceFailure(state ReaderState, error Exception) {
        state.Fault = Fault(error)
        state.Outcome = state.Stage == 1 ? 14 :
            state.Stage == 6 ? 6 :
            state.Stage == 7 ? 7 :
            state.Stage == 9 ? 5 : 8
    }

    func Quality(build BuildData, initial ProcessData, watcher ProcessData) int32 {
        if initial.Lost > 0 || watcher.Lost > 0 { return 3 }
        if build.Status == 0 && initial.Status == 0 && watcher.Status == 0 { return 1 }
        return 2
    }

    func Identify(assembly Assembly, kind int32) ReaderIdentity {
        let result = ReaderIdentity()
        result.Kind = kind
        try {
            let name = assembly.GetName()
            let version = name.Version
            let assemblyName = name.Name
            if version == nil || assemblyName == nil { return result }
            result.NameIdentity = Opaque(assemblyName)
            result.AssemblyMajor = version.Major
            result.AssemblyMinor = version.Minor
            result.AssemblyBuild = version.Build
            result.AssemblyRevision = version.Revision
            let path = assembly.Location
            if String.IsNullOrEmpty(path) || !File.Exists(path) { return result }
            let file = FileVersionInfo.GetVersionInfo(path)
            result.FileMajor = file.FileMajorPart
            result.FileMinor = file.FileMinorPart
            result.FileBuild = file.FileBuildPart
            result.FileRevision = file.FilePrivatePart
            result.Hash = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path)))
            result.Mvid = assembly.ManifestModule.ModuleVersionId.ToString("N")
            result.Known = true
        } catch {
            result.Known = false
        }
        return result
    }

    func Completeness(partial bool, lost int64, rundown bool, stacks bool) int32 {
        if partial { return 2 }
        if lost > 0 { return 4 }
        if !rundown { return 6 }
        if !stacks { return 5 }
        return 0
    }

    func IsCancellation(e TraceEvent) bool {
        return e.ProviderName == "Microsoft-Build" && int32(e.ID) == 93
    }

    func IsException(e TraceEvent) bool {
        return e.ProviderName == "Microsoft-Windows-DotNETRuntime" && int32(e.ID) == 80
    }

    func TraceEntry(e TraceEvent, trace TraceLog, kind int32) Entry {
        let result = Entry()
        result.Kind = kind
        result.Time = e.TimeStamp.ToUniversalTime().Ticks
        result.Thread = e.ThreadID
        if kind == 8 {
            let exceptionType = e.PayloadByName("ExceptionType") as string
            if exceptionType != nil {
                result.Identity = Opaque(exceptionType)
            }
            let code = e.PayloadByName("ExceptionHRESULT")
            if code is int32 signed {
                result.HResult = signed
                result.HasHResult = true
            } else if code is uint32 unsigned {
                result.HResult = int64(unsigned)
                result.HasHResult = true
            } else if code is int64 wide && wide >= -2147483648 && wide <= 4294967295 {
                result.HResult = wide
                result.HasHResult = true
            } else if code is uint64 positive && positive <= 4294967295 {
                result.HResult = int64(positive)
                result.HasHResult = true
            }
        }
        var index = trace.GetCallStackIndexForEvent(e)
        while index != CallStackIndex.Invalid && result.Frames.Count < 10 {
            let call = trace.CallStacks[index]
            let address = call.CodeAddress
            let name = address.FullMethodName
            if !name.StartsWith("System.Diagnostics.Tracing.", StringComparison.Ordinal) {
                let frame = Frame()
                frame.Category = MethodCategory(name)
                let method = address.Method
                if method != nil {
                    frame.Token = method.MethodToken
                }
                frame.Identity = Opaque(name)
                let module = address.ModuleFile
                let signature = module != nil ? module.PdbSignature.ToString("N") : ""
                frame.Module = Opaque(address.ModuleName + "|" + signature)
                if module != nil {
                    frame.PdbGuid = module.PdbSignature.ToString("N")
                }
                result.Frames.Add(frame)
            }
            index = trace.CallStacks.Caller(index)
        }
        result.FramesTruncated = index != CallStackIndex.Invalid
        return result
    }

    func ExceptionCategory(e TraceEvent) int32 {
        let value = e.PayloadByName("ExceptionType") as string
        if value == "Microsoft.Build.Exceptions.BuildAbortedException" { return 1 }
        if value == "System.OperationCanceledException" || value == "System.Threading.Tasks.TaskCanceledException" { return 2 }
        if value == "System.TimeoutException" { return 3 }
        if value == "System.IO.IOException" { return 4 }
        if value == "Microsoft.Build.Exceptions.InvalidProjectFileException" { return 5 }
        if value == "Microsoft.Build.Framework.InternalErrorException" { return 6 }
        if value == "System.InvalidOperationException" { return 7 }
        return 0
    }

    func Opaque(value string) string {
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)))
    }

    func MethodCategory(name string) int32 {
        if name.Contains("Microsoft.Build.Execution.BuildManager.CancelAllSubmissions(") { return 1 }
        if name.Contains("Microsoft.Build.Eventing.MSBuildEventSource.CancelSubmissionsStart(") { return 2 }
        if name.Contains("Microsoft.Build.Execution.BuildManager.HandleSubmissionException(") { return 3 }
        if name.Contains("Microsoft.Build.CommandLine.MSBuildApp.") { return 4 }
        if name.Contains("Microsoft.DotNet.Watch.") { return 5 }
        if name.Contains("System.Threading.CancellationTokenSource.") { return 6 }
        return 0
    }

    func NameCategory(name string) int32 {
        if name == "MSBuild" { return 1 }
        if name == "CoreCompile" { return 2 }
        if name == "GsharpCompile" || name == "GSharpCompile" { return 3 }
        if name == "ResolveReferences" { return 4 }
        if name == "Build" { return 5 }
        return 0
    }

    func ProjectRole(path string?) int32 {
        if path == nil { return 0 }
        let file = Path.GetFileName(path)
        if file == "App.gsproj" { return 1 }
        if file == "Lib.gsproj" { return 2 }
        if file == "Base.gsproj" { return 3 }
        return 0
    }

    func WriteBuild(writer Utf8JsonWriter, data BuildData) {
        writer.WriteStartObject()
        writer.WriteNumber("status", data.Status)
        writer.WriteNumber("succeeded", data.Succeeded)
        writer.WriteBoolean("build_started", data.Started)
        writer.WriteBoolean("build_finished_seen", data.Reader.Finished)
        writer.WriteBoolean("replay_returned", data.Reader.Returned)
        writer.WriteNumber("projects_started", data.ProjectsStarted)
        writer.WriteNumber("targets_started", data.TargetsStarted)
        writer.WriteNumber("tasks_started", data.TasksStarted)
        writer.WriteNumber("projects_finished", data.Projects)
        writer.WriteNumber("targets_finished", data.Targets)
        writer.WriteNumber("tasks_finished", data.Tasks)
        writer.WriteNumber("errors", data.Errors)
        writer.WriteNumber("cancellations", data.Cancellations)
        writer.WriteBoolean("selection_truncated", data.Truncated)
        writer.WriteStartArray("events")
        for item in data.Failures { WriteEntry(writer, item) }
        writer.WriteEndArray()
        writer.WritePropertyName("reader")
        WriteReader(writer, data.Reader)
        writer.WriteEndObject()
    }

    func WriteProcess(writer Utf8JsonWriter, data ProcessData) {
        writer.WriteStartObject()
        writer.WriteNumber("status", data.Status)
        writer.WriteNumber("role", data.Role)
        writer.WriteNumber("pid", data.Pid)
        writer.WriteNumber("events_lost", data.Lost)
        writer.WriteBoolean("rundown", data.Rundown)
        writer.WriteBoolean("has_stacks", data.HasStacks)
        writer.WriteNumber("exceptions", data.Exceptions)
        writer.WriteNumber("cancellations", data.Cancellations)
        writer.WriteBoolean("selection_truncated", data.Truncated)
        writer.WriteNumber("anchor_ticks", data.Anchor)
        writer.WriteStartArray("events")
        for item in data.Selected { WriteEntry(writer, item) }
        writer.WriteEndArray()
        writer.WritePropertyName("reader")
        WriteReader(writer, data.Reader)
        writer.WriteEndObject()
    }

    func WriteReader(writer Utf8JsonWriter, data ReaderState) {
        writer.WriteStartObject()
        writer.WriteNumber("stage", data.Stage)
        writer.WriteNumber("outcome", data.Outcome)
        writer.WriteBoolean("returned", data.Returned)
        writer.WriteBoolean("input_bytes_known", data.InputKnown)
        writer.WriteNumber("input_bytes", data.InputBytes)
        writer.WriteBoolean("header_known", data.HeaderKnown)
        writer.WriteNumber("format_version", data.FormatVersion)
        writer.WriteNumber("minimum_reader_version", data.MinimumReaderVersion)
        writer.WriteNumber("event_limit", data.EventLimit)
        writer.WriteNumber("events_seen", data.EventsSeen)
        writer.WriteBoolean("native_truncated", data.NativeTruncated)
        writer.WriteBoolean("limit_reached", data.LimitReached)
        writer.WriteStartObject("exception")
        writer.WriteBoolean("present", data.Fault.Present)
        writer.WriteString("type_identity", data.Fault.Identity)
        writer.WriteNumber("hresult", data.Fault.HResult)
        writer.WriteBoolean("hresult_present", data.Fault.HResultPresent)
        writer.WriteEndObject()
        writer.WriteEndObject()
    }

    func WriteIdentity(writer Utf8JsonWriter, data ReaderIdentity) {
        writer.WriteStartObject()
        writer.WriteNumber("kind", data.Kind)
        writer.WriteBoolean("known", data.Known)
        writer.WriteString("name_identity", data.NameIdentity)
        writer.WriteString("sha256", data.Hash)
        writer.WriteString("mvid", data.Mvid)
        writer.WriteStartArray("assembly_version")
        writer.WriteNumberValue(data.AssemblyMajor)
        writer.WriteNumberValue(data.AssemblyMinor)
        writer.WriteNumberValue(data.AssemblyBuild)
        writer.WriteNumberValue(data.AssemblyRevision)
        writer.WriteEndArray()
        writer.WriteStartArray("file_version")
        writer.WriteNumberValue(data.FileMajor)
        writer.WriteNumberValue(data.FileMinor)
        writer.WriteNumberValue(data.FileBuild)
        writer.WriteNumberValue(data.FileRevision)
        writer.WriteEndArray()
        writer.WriteEndObject()
    }

    func WriteEntry(writer Utf8JsonWriter, entry Entry) {
        writer.WriteStartObject()
        writer.WriteNumber("kind", entry.Kind)
        writer.WriteNumber("ticks", entry.Time)
        writer.WriteNumber("node", entry.Node)
        writer.WriteNumber("project", entry.Project)
        writer.WriteNumber("target", entry.Target)
        writer.WriteNumber("task", entry.Task)
        writer.WriteNumber("submission", entry.Submission)
        writer.WriteNumber("parent_project", entry.ParentProject)
        writer.WriteNumber("category", entry.Category)
        writer.WriteNumber("role", entry.Role)
        writer.WriteNumber("thread", entry.Thread)
        writer.WriteString("identity", entry.Identity)
        writer.WriteNumber("hresult", entry.HResult)
        writer.WriteBoolean("hresult_present", entry.HasHResult)
        writer.WriteBoolean("frames_truncated", entry.FramesTruncated)
        writer.WriteStartArray("frames")
        for frame in entry.Frames {
            writer.WriteStartObject()
            writer.WriteNumber("category", frame.Category)
            writer.WriteNumber("token", frame.Token)
            writer.WriteString("identity", frame.Identity)
            writer.WriteString("module", frame.Module)
            writer.WriteString("pdb_guid", frame.PdbGuid)
            writer.WriteEndObject()
        }
        writer.WriteEndArray()
        writer.WriteEndObject()
    }
}
