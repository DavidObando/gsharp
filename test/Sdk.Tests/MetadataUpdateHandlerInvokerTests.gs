// <copyright file="MetadataUpdateHandlerInvokerTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Sdk.Tests

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import Gsharp.HotReload.Runtime
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import Xunit

// Issue #4960: a handler registered by this assembly, found through the same
// discovery path the hot-reload agent uses after applying a delta.
@assembly: MetadataUpdateHandler(typeof(Issue4960RegisteredHandler))

/// Tests G#'s hot-reload dispatch of `MetadataUpdateHandler` callbacks
/// (issue #4960), which follows dotnet watch's `MetadataUpdateHandlerInvoker`.
open class MetadataUpdateHandlerInvokerTests {
    @Fact
    func EveryClearCache_RunsBeforeAnyUpdateApplication_WithTheUpdatedTypes() {
        Issue4960HandlerLog.Reset()
        let reports = List[string]()
        let invoker = MetadataUpdateHandlerInvoker((message string) -> reports.Add(message))
        let updatedTypes = []Type{typeof(string), typeof(int32)}
        invoker.GetUpdateHandlerActions([]Type{typeof(Issue4960FirstHandler), typeof(Issue4960SecondHandler)})
            .MetadataUpdated(updatedTypes)
        Assert.Equal(
            []string{
                "first ClearCache String,Int32",
                "second ClearCache String,Int32",
                "first UpdateApplication String,Int32",
                "second UpdateApplication String,Int32"
            },
            Issue4960HandlerLog.Entries.ToArray()
        )
        Assert.All(Issue4960HandlerLog.ReceivedTypes, (received[]?Type) -> Assert.Same(updatedTypes, received))
        Assert.Equal(4, Issue4960HandlerLog.ReceivedTypes.Count)
        Assert.Empty(reports)
    }

    @Fact
    func ThrowingHandler_IsReported_AndDoesNotStopOtherHandlers() {
        Issue4960HandlerLog.Reset()
        let reports = List[string]()
        let invoker = MetadataUpdateHandlerInvoker((message string) -> reports.Add(message))
        invoker.GetUpdateHandlerActions([]Type{typeof(Issue4960ThrowingHandler), typeof(Issue4960FirstHandler)})
            .MetadataUpdated(Type.EmptyTypes)
        Assert.Equal(
            []string{
                "throwing ClearCache",
                "first ClearCache ",
                "throwing UpdateApplication",
                "first UpdateApplication "
            },
            Issue4960HandlerLog.Entries.ToArray()
        )
        Assert.Equal(2, reports.Count)
        Assert.StartsWith(
            "GSHR1005: exception from 'GSharp.Sdk.Tests.Issue4960ThrowingHandler.ClearCache': System.InvalidOperationException: clear-cache-probe",
            reports[0],
            StringComparison.Ordinal
        )
        Assert.StartsWith(
            "GSHR1005: exception from 'GSharp.Sdk.Tests.Issue4960ThrowingHandler.UpdateApplication': System.InvalidOperationException: update-application-probe",
            reports[1],
            StringComparison.Ordinal
        )
    }

    @Fact
    func HandlerTypes_WithoutMatchingMethods_AreReported() {
        Issue4960HandlerLog.Reset()
        let reports = List[string]()
        let invoker = MetadataUpdateHandlerInvoker((message string) -> reports.Add(message))
        let actions = invoker.GetUpdateHandlerActions(
            []Type{typeof(Issue4960EmptyHandler), typeof(Issue4960MismatchedHandler), typeof(Issue4960FirstHandler)}
        )
        Assert.Equal(
            []string{"GSharp.Sdk.Tests.Issue4960FirstHandler.ClearCache"},
            actions
                .ClearCacheHandlers
                .Select((handler MetadataUpdateHandlerInvoker.UpdateHandler) -> handler.DisplayName)
                .ToArray()
        )
        Assert.Equal(
            []string{"GSharp.Sdk.Tests.Issue4960FirstHandler.UpdateApplication"},
            actions
                .UpdateApplicationHandlers
                .Select((handler MetadataUpdateHandlerInvoker.UpdateHandler) -> handler.DisplayName)
                .ToArray()
        )
        Assert.Equal(4, reports.Count)
        Assert.StartsWith(
            "GSHR1005: expected to find a static method 'ClearCache', 'UpdateApplication' or 'UpdateContent' on type 'GSharp.Sdk.Tests.Issue4960EmptyHandler, ",
            reports[0],
            StringComparison.Ordinal
        )
        // A wrong parameter list and an instance method are both mismatches,
        // and a type with no usable method is reported as such too.
        Assert.StartsWith(
            "GSHR1005: type 'GSharp.Sdk.Tests.Issue4960MismatchedHandler' has method 'Void ClearCache(System.String)'",
            reports[1],
            StringComparison.Ordinal
        )
        Assert.StartsWith(
            "GSHR1005: type 'GSharp.Sdk.Tests.Issue4960MismatchedHandler' has method 'Void UpdateApplication(System.Type[])'",
            reports[2],
            StringComparison.Ordinal
        )
        Assert.StartsWith(
            "GSHR1005: expected to find a static method 'ClearCache', 'UpdateApplication' or 'UpdateContent' on type 'GSharp.Sdk.Tests.Issue4960MismatchedHandler, ",
            reports[3],
            StringComparison.Ordinal
        )
        actions.MetadataUpdated(Type.EmptyTypes)
        Assert.Equal([]string{"first ClearCache ", "first UpdateApplication "}, Issue4960HandlerLog.Entries.ToArray())
    }

    @Fact
    func GenericHandlerMethod_IsReported_AndDoesNotStopOtherHandlers() {
        Issue4960HandlerLog.Reset()
        let reports = List[string]()
        let invoker = MetadataUpdateHandlerInvoker((message string) -> reports.Add(message))
        let actions = invoker.GetUpdateHandlerActions(
            []Type{typeof(Issue4960GenericMethodHandler), typeof(Issue4960FirstHandler)}
        )
        Assert.Equal(2, reports.Count)
        Assert.StartsWith(
            "GSHR1005: type 'GSharp.Sdk.Tests.Issue4960GenericMethodHandler' has method 'Void ClearCache[T](System.Type[])'",
            reports[0],
            StringComparison.Ordinal
        )
        Assert.StartsWith(
            "GSHR1005: expected to find a static method 'ClearCache', 'UpdateApplication' or 'UpdateContent' on type 'GSharp.Sdk.Tests.Issue4960GenericMethodHandler, ",
            reports[1],
            StringComparison.Ordinal
        )
        actions.MetadataUpdated(Type.EmptyTypes)
        Assert.Equal([]string{"first ClearCache ", "first UpdateApplication "}, Issue4960HandlerLog.Entries.ToArray())
    }

    @Fact
    func GenericOverload_DoesNotHideTheNonGenericHandler() {
        Issue4960HandlerLog.Reset()
        let reports = List[string]()
        let invoker = MetadataUpdateHandlerInvoker((message string) -> reports.Add(message))
        let actions = invoker.GetUpdateHandlerActions(
            []Type{typeof(Issue4960OverloadedHandler), typeof(Issue4960SecondHandler)}
        )
        Assert.Empty(reports)
        actions.MetadataUpdated(Type.EmptyTypes)
        Assert.Equal(
            []string{"overloaded ClearCache ", "second ClearCache ", "second UpdateApplication "},
            Issue4960HandlerLog.Entries.ToArray()
        )
    }

    @Fact
    func OpenGenericHandlerType_IsReported_AndOthersStillBind() {
        // The methods of an open generic handler type cannot be bound to a
        // delegate, so they are signature mismatches, not a discovery failure.
        Issue4960HandlerLog.Reset()
        let reports = List[string]()
        let invoker = MetadataUpdateHandlerInvoker((message string) -> reports.Add(message))
        let openHandler = typeof(Issue4960OpenGenericHandler[int32]).GetGenericTypeDefinition()
        let actions = invoker.GetUpdateHandlerActions([]Type{openHandler, typeof(Issue4960FirstHandler)})
        Assert.Equal(2, reports.Count)
        Assert.StartsWith(
            "GSHR1005: type 'GSharp.Sdk.Tests.Issue4960OpenGenericHandler`1[T]' has method 'Void ClearCache(System.Type[])' that does not match",
            reports[0],
            StringComparison.Ordinal
        )
        Assert.StartsWith(
            "GSHR1005: expected to find a static method 'ClearCache', 'UpdateApplication' or 'UpdateContent' on type 'GSharp.Sdk.Tests.Issue4960OpenGenericHandler`1",
            reports[1],
            StringComparison.Ordinal
        )
        actions.MetadataUpdated(Type.EmptyTypes)
        Assert.Equal([]string{"first ClearCache ", "first UpdateApplication "}, Issue4960HandlerLog.Entries.ToArray())
    }

    @Fact
    func ContentOnlyHandler_IsNotReported() {
        let reports = List[string]()
        let invoker = MetadataUpdateHandlerInvoker((message string) -> reports.Add(message))
        let actions = invoker.GetUpdateHandlerActions([]Type{typeof(Issue4960ContentOnlyHandler)})
        Assert.Empty(actions.ClearCacheHandlers)
        Assert.Empty(actions.UpdateApplicationHandlers)
        Assert.Empty(reports)
    }

    @Fact
    func HandlerTypes_FromDependencies_ComeBeforeTheirDependents() {
        // This test assembly reaches System.Private.CoreLib through the
        // System.Runtime facade, and CoreLib registers its own reflection
        // cache handler. Listing this assembly first must not put its
        // handler first.
        let testAssembly = typeof(Issue4960RegisteredHandler).Assembly
        let coreLibrary = typeof(object).Assembly
        let assemblies = []Assembly{testAssembly}.Concat(
            AppDomain
                .CurrentDomain
                .GetAssemblies()
                .Where((assembly Assembly) -> !object.ReferenceEquals(assembly, testAssembly))
        )
            .ToArray()
        let sorted = MetadataUpdateHandlerInvoker.TopologicalSort(assemblies)
        // Assemblies are matched by simple name, as dotnet watch does, so a
        // name loaded twice (for example in another load context) appears once.
        Assert.Equal(
            assemblies
                .Select((assembly Assembly) -> assembly.GetName().Name)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .Count(),
            sorted.Count
        )
        Assert.True(sorted.IndexOf(coreLibrary) < sorted.IndexOf(testAssembly))
        let reports = List[string]()
        let handlerTypes = MetadataUpdateHandlerInvoker((message string) -> reports.Add(message)).GetHandlerTypes(
            assemblies
        )
        let coreHandler = handlerTypes.FindIndex((type Type) -> object.ReferenceEquals(type.Assembly, coreLibrary))
        let testHandler = handlerTypes.IndexOf(typeof(Issue4960RegisteredHandler))
        Assert.True(coreHandler >= 0, "System.Private.CoreLib registers a metadata update handler")
        Assert.True(testHandler >= 0, "this assembly's registered handler is discovered")
        Assert.True(coreHandler < testHandler)
        Assert.Empty(reports)
    }

    @Fact
    func AssemblyLoadedAfterTheFirstUpdate_IsDiscoveredByTheNextUpdate() {
        // The agent's real wiring: discovery over the application domain,
        // invalidated by the AssemblyLoad hook. A handler in an assembly
        // that loads after the first update must run on the next one.
        let assemblyName = "Issue4960Late" + Guid.NewGuid().ToString("N")
        let clearKey = assemblyName + ".ClearCache"
        let updateKey = assemblyName + ".UpdateApplication"
        let source = `package Issue4960Late

import System
import System.Reflection.Metadata

@assembly: MetadataUpdateHandler(typeof(LateHandler))

internal class LateHandler {
    shared {
        func ClearCache(updatedTypes []?Type) {
            AppDomain.CurrentDomain.SetData("CLEAR_KEY", "ran")
        }

        func UpdateApplication(updatedTypes []?Type) {
            AppDomain.CurrentDomain.SetData("UPDATE_KEY", "ran")
        }
    }
}`
        let image = Issue4960LibraryCompiler.EmitLibrary(
            assemblyName,
            source.Replace("CLEAR_KEY", clearKey).Replace("UPDATE_KEY", updateKey)
        )
        let reports = List[string]()
        let invoker = MetadataUpdateHandlerInvoker((message string) -> reports.Add(message))
        invoker.ClearOnAssemblyLoad()
        invoker.MetadataUpdated(Type.EmptyTypes)
        Assert.Null(AppDomain.CurrentDomain.GetData(clearKey))
        let late = Assembly.Load(image)
        Assert.Equal(assemblyName, late.GetName().Name)
        invoker.MetadataUpdated(Type.EmptyTypes)
        Assert.Equal("ran", AppDomain.CurrentDomain.GetData(clearKey))
        Assert.Equal("ran", AppDomain.CurrentDomain.GetData(updateKey))
        Assert.DoesNotContain(reports, (report string) -> report.Contains(assemblyName, StringComparison.Ordinal))
    }

    @Fact
    func Discovery_IsCachedUntilAnAssemblyLoads() {
        Issue4960HandlerLog.Reset()
        let reports = List[string]()
        var available = Array.Empty[Assembly]()
        var scans = 0
        let invoker = MetadataUpdateHandlerInvoker(
            (message string) -> reports.Add(message),
            () -> {
                scans++
                return available
            }
        )
        invoker.MetadataUpdated(Type.EmptyTypes)
        Assert.Equal(1, scans)
        available = []Assembly{typeof(Issue4960RegisteredHandler).Assembly}
        invoker.MetadataUpdated(Type.EmptyTypes)
        Assert.Equal(1, scans)
        Assert.Empty(Issue4960HandlerLog.Entries)
        invoker.Clear()
        invoker.MetadataUpdated(Type.EmptyTypes)
        Assert.Equal(2, scans)
        Assert.Equal(
            []string{"registered ClearCache", "registered UpdateApplication"},
            Issue4960HandlerLog.Entries.ToArray()
        )
        invoker.MetadataUpdated(Type.EmptyTypes)
        Assert.Equal(2, scans)
        Assert.Empty(reports)
    }
}

internal class Issue4960LibraryCompiler {
    shared {
        func EmitLibrary(assemblyName string, source string)[]uint8 {
            let compilation = Compilation(SyntaxTree.Parse(source)){
                AssemblyName = assemblyName,
                IsLibrary = true,
                Optimize = false
            }
            using let peStream = MemoryStream()
            let result = compilation.Emit(
                peStream,
                pdbStream: nil,
                refStream: nil,
                assemblyName: assemblyName,
                assemblyVersion: "1.0.0"
            )
            Assert.True(
                result.Success,
                string.Join(
                    Environment.NewLine,
                    result.Diagnostics.Select((diagnostic Diagnostic) -> diagnostic.ToString())
                )
            )
            return peStream.ToArray()
        }
    }
}

internal class Issue4960HandlerLog {
    shared {
        let Entries List[string] = List[string]()
        let ReceivedTypes List[[]?Type] = List[[]?Type]()

        func Reset() {
            Entries.Clear()
            ReceivedTypes.Clear()
        }

        func Record(handler string, phase string, updatedTypes[]?Type) {
            ReceivedTypes.Add(updatedTypes)
            let names = if updatedTypes == nil {
                "<nil>"
            } else {
                string.Join(",", updatedTypes.Select((type Type) -> type.Name))
            }
            Entries.Add("$handler $phase $names")
        }
    }
}

internal class Issue4960FirstHandler {
    shared {
        func ClearCache(updatedTypes[]?Type) {
            Issue4960HandlerLog.Record("first", "ClearCache", updatedTypes)
        }

        func UpdateApplication(updatedTypes[]?Type) {
            Issue4960HandlerLog.Record("first", "UpdateApplication", updatedTypes)
        }
    }
}

internal class Issue4960SecondHandler {
    shared {
        private func ClearCache(updatedTypes[]?Type) {
            Issue4960HandlerLog.Record("second", "ClearCache", updatedTypes)
        }

        private func UpdateApplication(updatedTypes[]?Type) {
            Issue4960HandlerLog.Record("second", "UpdateApplication", updatedTypes)
        }
    }
}

internal class Issue4960ThrowingHandler {
    shared {
        func ClearCache(updatedTypes[]?Type) {
            Issue4960HandlerLog.Entries.Add("throwing ClearCache")
            throw InvalidOperationException("clear-cache-probe")
        }

        func UpdateApplication(updatedTypes[]?Type) {
            Issue4960HandlerLog.Entries.Add("throwing UpdateApplication")
            throw InvalidOperationException("update-application-probe")
        }
    }
}

internal class Issue4960EmptyHandler { }

internal class Issue4960MismatchedHandler {
    shared {
        func ClearCache(value string) {
            Issue4960HandlerLog.Entries.Add("mismatched ClearCache")
        }
    }

    func UpdateApplication(updatedTypes[]?Type) {
        Issue4960HandlerLog.Entries.Add("mismatched UpdateApplication")
    }
}

internal class Issue4960GenericMethodHandler {
    shared {
        func ClearCache[T](updatedTypes[]?Type) {
            Issue4960HandlerLog.Entries.Add("generic ClearCache")
        }
    }
}

internal class Issue4960OverloadedHandler {
    shared {
        func ClearCache(updatedTypes[]?Type) {
            Issue4960HandlerLog.Record("overloaded", "ClearCache", updatedTypes)
        }

        func ClearCache[T](updatedTypes[]?Type) {
            Issue4960HandlerLog.Entries.Add("overloaded generic ClearCache")
        }
    }
}

internal class Issue4960OpenGenericHandler[T] {
    shared {
        func ClearCache(updatedTypes[]?Type) {
            Issue4960HandlerLog.Entries.Add("open generic ClearCache")
        }
    }
}

internal class Issue4960ContentOnlyHandler {
    shared {
        func UpdateContent(assemblyName string, isApplicationProject bool, relativePath string, contents[]uint8) { }
    }
}

internal class Issue4960RegisteredHandler {
    shared {
        func ClearCache(updatedTypes[]?Type) {
            Issue4960HandlerLog.Entries.Add("registered ClearCache")
        }

        func UpdateApplication(updatedTypes[]?Type) {
            Issue4960HandlerLog.Entries.Add("registered UpdateApplication")
        }
    }
}
