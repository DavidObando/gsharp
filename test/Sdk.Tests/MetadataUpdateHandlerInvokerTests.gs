// <copyright file="MetadataUpdateHandlerInvokerTests.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Sdk.Tests

import Gsharp.HotReload.Runtime
import System
import System.Collections.Generic
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
