// <copyright file="EmitContext.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.IO
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335

/// Cross-cutting state shared across a single (cref:ReflectionMetadataEmitter)
/// instance and (in subsequent extraction PRs) the components a
/// (cref:ReflectionMetadataEmitter) composes — `MetadataTokenCache`,
/// `WellKnownReferences`, `SlotPlanner`, and so on.
/// @remarks PR-E-1 introduces this type as the foundation for the
/// (cref:ReflectionMetadataEmitter) decomposition described in the
/// repository-level decomposition plan. No methods are moved in this PR; only
/// the cross-cutting state that downstream extractions will need to consume
/// via constructor injection is centralised here.
///
/// State that is deliberately <em>not</em> on (cref:EmitContext) yet:
/// the per-emitter handle/cache dictionaries (move in PR-E-2
/// `MetadataTokenCache`), the lazily-resolved BCL member references
/// (move in PR-E-3 `WellKnownReferences`), the closure/state-machine
/// bookkeeping (move in PR-E-9 / PR-E-10), and the async/iterator rewriter
/// plans (logically per-emitter, set once via the static
/// (cref:ReflectionMetadataEmitter.Emit) entry point).
internal class EmitContext {
    /// Initializes a new instance of the (cref:EmitContext) class.
    /// @param program The bound program being emitted.
    /// @param references Reference resolver providing the target framework's core types and any
    /// user-supplied imports. When `null`, the default in-process
    /// resolver is used.
    /// @param assemblyName Optional override for the assembly identity (module + assembly rows).
    /// When `null`, the emitter falls back to the entry-point
    /// package's name.
    /// @param metadataOnly When `true`, the emit pipeline produces a
    /// metadata-only reference assembly (no method bodies, marked with
    /// `System.Runtime.CompilerServices.ReferenceAssemblyAttribute`).
    init(program BoundProgram, references ReferenceResolver?, assemblyName string?, metadataOnly bool) {
        this.Program = program
        this.References = references ?? ReferenceResolver.Default()
        this.AssemblyNameOverride = assemblyName
        this.MetadataOnly = metadataOnly
        this.Metadata = MetadataBuilder()
        this.MetadataRows = MetadataRowInterner(this.Metadata)
        this.IlStream = BlobBuilder()
        this.MethodBodyStream = MethodBodyStreamEncoder(this.IlStream)
        this.DebugInformation = DebugInformationOptions()
        this.PendingGenericParameters = List[PendingGenericParameter]()
        this.InheritedInterfaceMethods,
        this.InheritedInterfacePropertyAccessors = MethodInfoHelpers.GetInheritedInterfaceImplementations(program)
        // Resolved here rather than part-way through emit so the context never
        // exists in a half-initialized state (ADR-0155: tighten the
        // construction path instead of widening the declaration). Resolution
        // needs nothing but References, and falls back to the host's own type
        // when the target framework does not carry one, so every Core*Type is
        // non-null for the whole lifetime of the context.
        this.CoreObjectType = this.ResolveCoreType("System.Object", typeof(object))
        this.CoreStringType = this.ResolveCoreType("System.String", typeof(string))
        this.CoreInt32Type = this.ResolveCoreType("System.Int32", typeof(int32))
        this.CoreBooleanType = this.ResolveCoreType("System.Boolean", typeof(bool))
        this.CoreArrayType = this.ResolveCoreType("System.Array", typeof(Array))
        this.CoreValueType = this.ResolveCoreType("System.ValueType", typeof(ValueType))
        this.CoreSystemType = this.ResolveCoreType("System.Type", typeof(Type))
        this.CoreRuntimeTypeHandleType = this.ResolveCoreType("System.RuntimeTypeHandle", typeof(RuntimeTypeHandle))
        this.CoreRuntimeMethodHandleType = this.ResolveCoreType(
            "System.RuntimeMethodHandle",
            typeof(RuntimeMethodHandle)
        )
        this.CoreMethodBaseType = this.ResolveCoreType("System.Reflection.MethodBase", typeof(MethodBase))
        this.CoreEnumType = this.ResolveCoreType("System.Enum", typeof(Enum))
        this.CoreMulticastDelegateType = this.ResolveCoreType("System.MulticastDelegate", typeof(MulticastDelegate))
        this.CoreIntPtrType = this.ResolveCoreType("System.IntPtr", typeof(nint))
    }

    /// Gets the bound program being emitted.
    prop Program BoundProgram {
        get;
    }

    /// Gets inherited source methods selected for a descendant's interface slots.
    prop InheritedInterfaceMethods HashSet[FunctionSymbol] {
        get;
    }

    /// Gets inherited property accessors selected for a descendant's interface slots.
    prop InheritedInterfacePropertyAccessors HashSet[(Property PropertySymbol, IsGetter bool)] {
        get;
    }

    /// Gets the reference resolver associated with this emit. Provided as a
    /// first-class accessor so downstream extracted components don't need to
    /// reach back into (cref:ReflectionMetadataEmitter).
    prop References ReferenceResolver {
        get;
    }

    /// Gets the assembly-identity override supplied by the SDK (e.g. from
    /// MSBuild's `AssemblyName`). `null` means "fall
    /// back to the entry-point package's name".
    prop AssemblyNameOverride string? {
        get;
    }

    /// Gets a value indicating whether this is a metadata-only reference-
    /// assembly emit (no method bodies, marked with
    /// `ReferenceAssemblyAttribute`).
    prop MetadataOnly bool {
        get;
    }

    /// Gets or sets a value indicating whether the emitted runtime assembly
    /// allows JIT optimization.
    private var _optimize bool = true

    prop Optimize bool {
        get {
            return _optimize
        }
        set {
            _optimize = value
        }
    }

    /// Gets the ECMA-335 metadata builder used to assemble the PE's metadata
    /// tables for this emit.
    prop Metadata MetadataBuilder {
        get;
    }

    /// Gets the interner that adds `MemberRef`, `TypeSpec` and `MethodSpec`
    /// rows to (cref:Metadata) once per distinct row (issue #5172). Add those
    /// rows through it, never through (cref:Metadata) directly.
    prop MetadataRows MetadataRowInterner {
        get;
    }

    /// Gets the deferred buffer of `GenericParam` rows. ECMA-335 II.22.20
    /// requires this table sorted by (Owner, Number). Because TypeDefs and
    /// MethodDefs are emitted in different visit orders, we cannot AddGenericParameter
    /// inline without violating the sort invariant. ADR-0087 §3 R1: deferred,
    /// then flushed in sorted order before PE serialisation.
    prop PendingGenericParameters List[PendingGenericParameter] {
        get;
    }

    /// Gets the IL byte stream into which method-body encoders write.
    prop IlStream BlobBuilder {
        get;
    }

    /// Gets the method-body stream encoder layered over
    /// (cref:IlStream); used by the body emitter to reserve method
    /// body offsets for (cref:MetadataBuilder.AddMethodDefinition).
    prop MethodBodyStream MethodBodyStreamEncoder {
        get;
    }

    /// Gets or sets the informational assembly version stamped on the assembly
    /// row. Set by the static (cref:ReflectionMetadataEmitter.Emit)
    /// entry point from the SDK-supplied value.
    prop AssemblyVersionOverride string?

    /// Gets or sets the long target framework moniker stamped on the assembly.
    prop TargetFrameworkMoniker string?

    /// Gets or sets the Portable PDB options for this emit. Set by the static
    /// (cref:ReflectionMetadataEmitter.Emit) entry point; defaulted to
    /// a (cref:DebugInformationFormat.None) instance by the constructor
    /// so the existing PE-only path stays bit-for-bit identical until PDB
    /// emission is requested.
    prop DebugInformation DebugInformationOptions

    /// Gets or sets the destination stream for the Portable PDB sidecar.
    /// Only consumed when
    /// (cref:DebugInformation).(cref:DebugInformationOptions.Format)
    /// is (cref:DebugInformationFormat.Portable); ignored otherwise.
    prop PdbStream Stream?

    /// Gets or sets the Portable PDB collaborator. Instantiated by
    /// `EmitCore` when the caller requested portable or embedded PDBs;
    /// `null` in every other configuration so the legacy PE-
    /// only emit path stays bit-for-bit identical.
    prop Pdb PortablePdbEmitter?

    /// Gets the BCL (cref:object) (cref:Type) resolved
    /// from the target framework's (cref:References).
    /// @remarks Every `Core*Type` is resolved by the constructor and is non-null for
    /// the lifetime of the context: resolution falls back to the host's own type
    /// when the target framework's references do not carry it.
    prop CoreObjectType Type {
        get;
    }

    /// Gets the BCL (cref:string) (cref:Type) resolved
    /// from the target framework's (cref:References).
    prop CoreStringType Type {
        get;
    }

    /// Gets the BCL (cref:int)
    /// (cref:Type) resolved from the target framework's
    /// (cref:References).
    prop CoreInt32Type Type {
        get;
    }

    /// Gets the BCL (cref:bool) (cref:Type) resolved
    /// from the target framework's (cref:References).
    prop CoreBooleanType Type {
        get;
    }

    /// Gets the BCL (cref:Array) (cref:Type) resolved
    /// from the target framework's (cref:References).
    prop CoreArrayType Type {
        get;
    }

    /// Gets the BCL (cref:ValueType) (cref:Type) resolved
    /// from the target framework's (cref:References).
    prop CoreValueType Type {
        get;
    }

    /// Gets the BCL (cref:System.Type) reflection-info type
    /// resolved from the target framework's (cref:References).
    prop CoreSystemType Type {
        get;
    }

    /// Gets the BCL (cref:RuntimeTypeHandle) type resolved from
    /// the target framework's (cref:References).
    prop CoreRuntimeTypeHandleType Type {
        get;
    }

    /// Gets the BCL (cref:System.RuntimeMethodHandle) type
    /// resolved from the target framework's (cref:References).
    /// Issue #2373: backs emission of a (cref:System.Reflection.MethodInfo)
    /// runtime constant (`ldtoken method ; call
    /// MethodBase.GetMethodFromHandle`) for expression-tree lowering's CLR
    /// operator-method arguments.
    prop CoreRuntimeMethodHandleType Type {
        get;
    }

    /// Gets the BCL (cref:System.Reflection.MethodBase) type
    /// resolved from the target framework's (cref:References). See
    /// (cref:CoreRuntimeMethodHandleType).
    prop CoreMethodBaseType Type {
        get;
    }

    /// Gets the BCL (cref:Enum) type resolved from the target
    /// framework's (cref:References).
    prop CoreEnumType Type {
        get;
    }

    /// Gets the BCL (cref:MulticastDelegate) type resolved from
    /// the target framework's (cref:References). Used as the base type
    /// for user-declared named delegate emission (ADR-0059 / issue #255).
    prop CoreMulticastDelegateType Type {
        get;
    }

    /// Gets the BCL (cref:IntPtr) type resolved from the
    /// target framework's (cref:References). Used as the second
    /// parameter type on synthesized delegate constructors.
    prop CoreIntPtrType Type {
        get;
    }

    /// Gets or sets the declaring type whose synthesized static constructor
    /// (`.cctor`) is currently being planned/emitted, or
    /// `null` when a normal method (or an instance
    /// `.ctor`) is being emitted. Issue #1525: taking the address of an
    /// `initonly` static field (`ldsflda`) is only verifiable inside
    /// that field's declaring type-initializer; the receiver-addressability
    /// predicate (cref:ReflectionMetadataEmitter.IsStaticFieldAddressLegalHere)
    /// consults this to decide whether a static readonly value-type field
    /// receiver must be spilled to a temp (defensive copy) instead of addressed
    /// in place. Set for the duration of a synthesized `.cctor` body by
    /// `ConstructorBodyEmitter` (PR-E-15).
    prop CurrentStaticConstructorOwner Symbol?

    /// Resolves a BCL type from the target framework's references, falling back
    /// to the host's own type when the references do not carry it.
    /// @param fullName The metadata full name to resolve.
    /// @param fallback The host type to use when resolution fails.
    /// @returns The resolved type; never `null`.
    private func ResolveCoreType(fullName string, fallback Type) Type -> if this.References.TryResolveType(
        fullName,
        requireExternalVisibility: false,
        out var resolved
    ) {
        resolved!!
    } else {
        fallback
    }
}
