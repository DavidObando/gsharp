import System
import System.Collections.Generic
import System.IO
import System.Security.Cryptography
import System.Text
import System.Text.Json
import Microsoft.Build.Framework
import Microsoft.Build.Logging
import Microsoft.Diagnostics.Tracing
import Microsoft.Diagnostics.Tracing.Etlx

return Projection.Run(args)

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
    var Projects int32
    var Targets int32
    var Tasks int32
    var Errors int32
    var Cancellations int32
    var Truncated bool
    var FirstNegative int64
    var Failures List[Entry] = List[Entry]()
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
}

internal shared class Projection {
    func Run(arguments []string) int32 {
        if arguments.Length != 6 {
            return 2
        }
        try {
            let build = ReadBuild(arguments[0])
            let initial = ReadProcess(arguments[1], int32.Parse(arguments[3]), 1, build.FirstNegative)
            let watcher = ReadProcess(arguments[2], int32.Parse(arguments[4]), 2, build.FirstNegative)
            using let stream = MemoryStream()
            using let writer = Utf8JsonWriter(stream)
            writer.WriteStartObject()
            writer.WriteNumber("schema", 1)
            writer.WriteBoolean("absence_proven", false)
            writer.WriteBoolean("cross_process_order_exact", false)
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
        let result = BuildData()
        if !File.Exists(path) {
            return result
        }
        if FileInfo(path).Length > 16777216 {
            result.Status = 3
            return result
        }
        try {
            let source = BinaryLogReplayEventSource()
            let parents = Dictionary[int32, int32]()
            source.AnyEventRaised += func (_ object?, e BuildEventArgs) {
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
                if e is BuildFinishedEventArgs finished {
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
                    let parent = started.ParentProjectBuildEventContext
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
            }
            source.Replay(path)
            result.Status = result.Finished ? 0 : 2
        } catch {
            result.Status = 2
        }
        return result
    }

    func ReadProcess(path string, pid int32, role int32, negative int64) ProcessData {
        let result = ProcessData()
        result.Pid = pid
        result.Role = role
        if !File.Exists(path) || pid <= 0 {
            return result
        }
        if FileInfo(path).Length > 67108864 {
            result.Status = 3
            return result
        }
        try {
            let options = TraceLogOptions()
            options.KeepAllEvents = true
            options.ContinueOnError = false
            options.LocalSymbolsOnly = true
            options.MaxEventCount = 1000000
            options.ConversionLog = TextWriter.Null
            let converted = path + ".etlx"
            TraceLog.CreateFromEventPipeDataFile(path, converted, options)
            using let trace = TraceLog(converted)
            result.Lost = trace.EventsLost
            result.HasStacks = trace.HasCallStacks
            result.Truncated = trace.Truncated
            var anchor = negative
            for e in trace.Events {
                if e.ProcessID != pid {
                    continue
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
            }
            let before = List[Entry]()
            result.Anchor = anchor
            let after = List[Entry]()
            let priorityBefore = List[Entry]()
            let priorityAfter = List[Entry]()
            for e in trace.Events {
                if e.ProcessID != pid || !IsException(e) {
                    continue
                }
                let time = e.TimeStamp.ToUniversalTime().Ticks
                let category = ExceptionCategory(e)
                let close = anchor == 0 || Math.Abs(time - anchor) <= 20000000
                if !close {
                    continue
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
            }
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
        } catch {
            result.Status = 2
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
        writer.WriteNumber("projects_finished", data.Projects)
        writer.WriteNumber("targets_finished", data.Targets)
        writer.WriteNumber("tasks_finished", data.Tasks)
        writer.WriteNumber("errors", data.Errors)
        writer.WriteNumber("cancellations", data.Cancellations)
        writer.WriteBoolean("selection_truncated", data.Truncated)
        writer.WriteStartArray("events")
        for item in data.Failures { WriteEntry(writer, item) }
        writer.WriteEndArray()
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
