// <copyright file="MetadataUpdateHandlerInvoker.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Gsharp.HotReload.Runtime

import System
import System.Collections.Generic
import System.Reflection
import System.Threading

/// Finds and invokes the `[assembly: MetadataUpdateHandler(typeof(T))]`
/// handlers of the loaded assemblies after a delta is applied (issue #4960).
/// @remarks (cref:System.Reflection.Metadata.MetadataUpdater) applies a delta
/// but never calls these handlers; the agent that applies the delta must. This
/// follows `dotnet watch`'s `MetadataUpdateHandlerInvoker`: handlers are
/// discovered after the first update and cached until an assembly loads,
/// assemblies are ordered dependencies first, every `ClearCache` runs before
/// any `UpdateApplication`, and a failing handler is reported without
/// stopping the others. G# applies no static-asset updates, so an
/// `UpdateContent` method is recognised but never called. Callers serialize
/// (cref:MetadataUpdated); (cref:Clear) may run on any thread.
internal class MetadataUpdateHandlerInvoker {
    private let report(string) -> void
    private let getAssemblies() -> []Assembly
    private var actions RegisteredActions?
    private var actionsVersion int32
    private var assemblyLoadVersion int32

    /// Creates an invoker over the current application domain's assemblies.
    /// @param report Receives one warning per handler problem.
    init(report(string) -> void) {
        this.report = report
        this.getAssemblies = () -> AppDomain.CurrentDomain.GetAssemblies()
    }

    /// Creates an invoker over a supplied assembly list (for tests).
    /// @param report Receives one warning per handler problem.
    /// @param getAssemblies Returns the assemblies to search for handlers.
    init(report(string) -> void, getAssemblies() -> []Assembly) {
        this.report = report
        this.getAssemblies = getAssemblies
    }

    /// Discards the cached handlers. Call when an assembly loads.
    func Clear() {
        Interlocked.Increment(&this.assemblyLoadVersion)
    }

    /// Invokes every `ClearCache` handler, then every `UpdateApplication`
    /// handler, with the types the applied delta changed.
    /// @param updatedTypes Changed types in update order.
    func MetadataUpdated(updatedTypes[]Type) {
        try {
            this.GetActions().MetadataUpdated(updatedTypes)
        } catch (ex Exception) {
            this.report("GSHR1005: metadata update handlers failed: $ex")
        }
    }

    /// Returns the handler types registered by `assemblies`, with the
    /// handlers of each dependency before those of its dependents.
    /// @param assemblies Assemblies to search.
    /// @returns Handler types in invocation order.
    func GetHandlerTypes(assemblies[]Assembly) List[Type] {
        let handlerTypes = List[Type]()
        for assembly in TopologicalSort(assemblies) {
            for attribute in this.TryGetCustomAttributesData(assembly) {
                // Match by name, as dotnet watch does, so a netstandard
                // library may declare its own copy of the attribute.
                if attribute.AttributeType.FullName != MetadataUpdateHandlerAttributeName {
                    continue
                }
                let arguments = attribute.ConstructorArguments
                if arguments.Count == 1 && arguments[0].Value is Type handlerType {
                    handlerTypes.Add(handlerType)
                } else {
                    this.report("GSHR1005: '$attribute' found with invalid arguments.")
                }
            }
        }
        return handlerTypes
    }

    /// Binds the handler methods of `handlerTypes`, reporting a handler type
    /// that has none and a same-named method with the wrong signature.
    /// @param handlerTypes Handler types in invocation order.
    /// @returns The bound handlers.
    func GetUpdateHandlerActions(handlerTypes IEnumerable[Type]) RegisteredActions {
        let clearCacheHandlers = List[UpdateHandler]()
        let updateApplicationHandlers = List[UpdateHandler]()
        for handlerType in handlerTypes {
            var methodFound = false
            let clearCache MethodInfo? = this.GetHandlerMethod(
                handlerType,
                ClearCacheHandlerName,
                MetadataUpdateSignature
            )
            if clearCache != nil {
                clearCacheHandlers.Add(this.CreateHandler(handlerType, clearCache))
                methodFound = true
            }
            let updateApplication MethodInfo? = this.GetHandlerMethod(
                handlerType,
                UpdateApplicationHandlerName,
                MetadataUpdateSignature
            )
            if updateApplication != nil {
                updateApplicationHandlers.Add(this.CreateHandler(handlerType, updateApplication))
                methodFound = true
            }
            if this.GetHandlerMethod(handlerType, UpdateContentHandlerName, ContentUpdateSignature) != nil {
                methodFound = true
            }
            if !methodFound {
                this.report(
                    "GSHR1005: expected to find a static method '$ClearCacheHandlerName', '$UpdateApplicationHandlerName' or '$UpdateContentHandlerName' on type '${handlerType.AssemblyQualifiedName}' but neither exists."
                )
            }
        }
        return RegisteredActions(clearCacheHandlers, updateApplicationHandlers)
    }

    private func GetActions() RegisteredActions {
        // Discovery waits for the first update, so the assemblies the
        // application loads at startup are all present. Reading the load
        // version before the scan makes a load during the scan force the
        // next update to rescan.
        let version = Volatile.Read(&this.assemblyLoadVersion)
        let cached RegisteredActions? = this.actions
        if cached != nil && this.actionsVersion == version {
            return cached
        }
        let discovered = this.GetUpdateHandlerActions(this.GetHandlerTypes(this.getAssemblies()))
        this.actions = discovered
        this.actionsVersion = version
        return discovered
    }

    private func GetHandlerMethod(handlerType Type, name string, signature[]Type) MethodInfo? {
        let method MethodInfo? = handlerType.GetMethod(
            name,
            HandlerMethodBindingFlags,
            binder: nil,
            signature,
            modifiers: nil
        )
        if method != nil && method.ReturnType == typeof(void) {
            return method
        }
        for candidate in handlerType.GetMethods(HandlerMethodBindingFlags | BindingFlags.Instance) {
            if candidate.Name == name {
                this.report(
                    "GSHR1005: type '$handlerType' has method '$candidate' that does not match the required signature."
                )
                break
            }
        }
        return nil
    }

    private func CreateHandler(handlerType Type, method MethodInfo) UpdateHandler {
        let action = method.CreateDelegate[([]?Type) -> void]()
        let displayName = "${handlerType.FullName}.${method.Name}"
        return UpdateHandler(
            displayName,
            (updatedTypes[]Type) -> {
                try {
                    action(updatedTypes)
                } catch (ex Exception) {
                    this.report("GSHR1005: exception from '$displayName': $ex")
                }
            }
        )
    }

    private func TryGetCustomAttributesData(assembly Assembly) IList[CustomAttributeData] {
        try {
            return assembly.GetCustomAttributesData()
        } catch {
            // dotnet watch skips an assembly whose attributes cannot be read
            // (for example one that is only partially available on this OS).
            return List[CustomAttributeData]()
        }
    }

    /// One bound handler method.
    internal class UpdateHandler {
        init(displayName string, invoke([]Type) -> void) {
            this.DisplayName = displayName
            this.Invoke = invoke
        }

        /// Gets the handler's `Type.Method` name.
        prop DisplayName string {
            get;
        }

        /// Gets the invocation, which reports and absorbs the handler's
        /// exceptions.
        prop Invoke([]Type) -> void {
            get;
        }
    }

    /// The handlers found by one discovery pass.
    internal class RegisteredActions {
        init(clearCacheHandlers List[UpdateHandler], updateApplicationHandlers List[UpdateHandler]) {
            this.ClearCacheHandlers = clearCacheHandlers
            this.UpdateApplicationHandlers = updateApplicationHandlers
        }

        /// Gets the `ClearCache` handlers in invocation order.
        prop ClearCacheHandlers IReadOnlyList[UpdateHandler] {
            get;
        }

        /// Gets the `UpdateApplication` handlers in invocation order.
        prop UpdateApplicationHandlers IReadOnlyList[UpdateHandler] {
            get;
        }

        /// Runs every `ClearCache` handler, then every `UpdateApplication`
        /// handler.
        /// @param updatedTypes Changed types in update order.
        func MetadataUpdated(updatedTypes[]Type) {
            for handler in this.ClearCacheHandlers {
                handler.Invoke(updatedTypes)
            }
            for handler in this.UpdateApplicationHandlers {
                handler.Invoke(updatedTypes)
            }
        }
    }

    shared {
        private const MetadataUpdateHandlerAttributeName string = "System.Reflection.Metadata.MetadataUpdateHandlerAttribute"
        private const ClearCacheHandlerName string = "ClearCache"
        private const UpdateApplicationHandlerName string = "UpdateApplication"
        private const UpdateContentHandlerName string = "UpdateContent"
        private const HandlerMethodBindingFlags BindingFlags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static
        private let MetadataUpdateSignature[]Type = []Type{typeof([]Type)}
        private let ContentUpdateSignature[]Type = []Type{typeof(string), typeof(bool), typeof(string), typeof([]uint8)}

        /// Orders `assemblies` so each one follows the assemblies it
        /// references, matching assemblies by simple name.
        /// @param assemblies Assemblies to order.
        /// @returns The assemblies, dependencies first.
        func TopologicalSort(assemblies[]Assembly) List[Assembly] {
            let sorted = List[Assembly](assemblies.Length)
            let visited = HashSet[string](StringComparer.OrdinalIgnoreCase)
            for assembly in assemblies {
                Visit(assemblies, assembly, sorted, visited)
            }
            return sorted
        }

        private func Visit(assemblies[]Assembly, assembly Assembly, sorted List[Assembly], visited HashSet[string]) {
            let name string? = TryGetName(assembly)
            if name == nil || !visited.Add(name) {
                return
            }
            var references[]AssemblyName = Array.Empty[AssemblyName]()
            try {
                references = assembly.GetReferencedAssemblies()
            } catch {
                // Treat an assembly whose references cannot be read as a leaf.
                references = Array.Empty[AssemblyName]()
            }
            for reference in references {
                let referenceName string? = reference.Name
                if referenceName == nil {
                    continue
                }
                for candidate in assemblies {
                    if string.Equals(TryGetName(candidate), referenceName, StringComparison.OrdinalIgnoreCase) {
                        Visit(assemblies, candidate, sorted, visited)
                        break
                    }
                }
            }
            sorted.Add(assembly)
        }

        private func TryGetName(assembly Assembly) string? {
            try {
                return assembly.GetName().Name
            } catch {
                return nil
            }
        }
    }
}
