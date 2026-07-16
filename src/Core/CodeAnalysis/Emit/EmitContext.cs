// <copyright file="EmitContext.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Symbols;

namespace GSharp.Core.CodeAnalysis.Emit;

/// <summary>
/// Cross-cutting state shared across a single <see cref="ReflectionMetadataEmitter"/>
/// instance and (in subsequent extraction PRs) the components a
/// <see cref="ReflectionMetadataEmitter"/> composes — <c>MetadataTokenCache</c>,
/// <c>WellKnownReferences</c>, <c>SlotPlanner</c>, and so on.
/// </summary>
/// <remarks>
/// <para>
/// PR-E-1 introduces this type as the foundation for the
/// <see cref="ReflectionMetadataEmitter"/> decomposition described in the
/// repository-level decomposition plan. No methods are moved in this PR; only
/// the cross-cutting state that downstream extractions will need to consume
/// via constructor injection is centralised here.
/// </para>
/// <para>
/// State that is deliberately <em>not</em> on <see cref="EmitContext"/> yet:
/// the per-emitter handle/cache dictionaries (move in PR-E-2
/// <c>MetadataTokenCache</c>), the lazily-resolved BCL member references
/// (move in PR-E-3 <c>WellKnownReferences</c>), the closure/state-machine
/// bookkeeping (move in PR-E-9 / PR-E-10), and the async/iterator rewriter
/// plans (logically per-emitter, set once via the static
/// <see cref="ReflectionMetadataEmitter.Emit"/> entry point).
/// </para>
/// </remarks>
internal sealed class EmitContext
{
    /// <summary>
    /// Initializes a new instance of the <see cref="EmitContext"/> class.
    /// </summary>
    /// <param name="program">The bound program being emitted.</param>
    /// <param name="references">
    /// Reference resolver providing the target framework's core types and any
    /// user-supplied imports. When <see langword="null"/>, the default in-process
    /// resolver is used.
    /// </param>
    /// <param name="assemblyName">
    /// Optional override for the assembly identity (module + assembly rows).
    /// When <see langword="null"/>, the emitter falls back to the entry-point
    /// package's name.
    /// </param>
    /// <param name="metadataOnly">
    /// When <see langword="true"/>, the emit pipeline produces a
    /// metadata-only reference assembly (no method bodies, marked with
    /// <c>System.Runtime.CompilerServices.ReferenceAssemblyAttribute</c>).
    /// </param>
    public EmitContext(BoundProgram program, ReferenceResolver references, string assemblyName, bool metadataOnly)
    {
        this.Program = program;
        this.References = references ?? ReferenceResolver.Default();
        this.AssemblyNameOverride = assemblyName;
        this.MetadataOnly = metadataOnly;
        this.Metadata = new MetadataBuilder();
        this.IlStream = new BlobBuilder();
        this.MethodBodyStream = new MethodBodyStreamEncoder(this.IlStream);
        this.DebugInformation = new DebugInformationOptions();
        this.PendingGenericParameters = new System.Collections.Generic.List<PendingGenericParameter>();
    }

    /// <summary>
    /// Gets the bound program being emitted.
    /// </summary>
    public BoundProgram Program { get; }

    /// <summary>
    /// Gets the reference resolver associated with this emit. Provided as a
    /// first-class accessor so downstream extracted components don't need to
    /// reach back into <see cref="ReflectionMetadataEmitter"/>.
    /// </summary>
    public ReferenceResolver References { get; }

    /// <summary>
    /// Gets the assembly-identity override supplied by the SDK (e.g. from
    /// MSBuild's <c>AssemblyName</c>). <see langword="null"/> means "fall
    /// back to the entry-point package's name".
    /// </summary>
    public string AssemblyNameOverride { get; }

    /// <summary>
    /// Gets a value indicating whether this is a metadata-only reference-
    /// assembly emit (no method bodies, marked with
    /// <c>ReferenceAssemblyAttribute</c>).
    /// </summary>
    public bool MetadataOnly { get; }

    /// <summary>
    /// Gets the ECMA-335 metadata builder used to assemble the PE's metadata
    /// tables for this emit.
    /// </summary>
    public MetadataBuilder Metadata { get; }

    /// <summary>
    /// Gets the deferred buffer of <c>GenericParam</c> rows. ECMA-335 II.22.20
    /// requires this table sorted by (Owner, Number). Because TypeDefs and
    /// MethodDefs are emitted in different visit orders, we cannot AddGenericParameter
    /// inline without violating the sort invariant. ADR-0087 §3 R1: deferred,
    /// then flushed in sorted order before PE serialisation.
    /// </summary>
    public System.Collections.Generic.List<PendingGenericParameter> PendingGenericParameters { get; }

    /// <summary>
    /// Gets the IL byte stream into which method-body encoders write.
    /// </summary>
    public BlobBuilder IlStream { get; }

    /// <summary>
    /// Gets the method-body stream encoder layered over
    /// <see cref="IlStream"/>; used by the body emitter to reserve method
    /// body offsets for <see cref="MetadataBuilder.AddMethodDefinition"/>.
    /// </summary>
    public MethodBodyStreamEncoder MethodBodyStream { get; }

    /// <summary>
    /// Gets or sets the informational assembly version stamped on the assembly
    /// row. Set by the static <see cref="ReflectionMetadataEmitter.Emit"/>
    /// entry point from the SDK-supplied value.
    /// </summary>
    public string AssemblyVersionOverride { get; set; }

    /// <summary>
    /// Gets or sets the Portable PDB options for this emit. Set by the static
    /// <see cref="ReflectionMetadataEmitter.Emit"/> entry point; defaulted to
    /// a <see cref="DebugInformationFormat.None"/> instance by the constructor
    /// so the existing PE-only path stays bit-for-bit identical until PDB
    /// emission is requested.
    /// </summary>
    public DebugInformationOptions DebugInformation { get; set; }

    /// <summary>
    /// Gets or sets the destination stream for the Portable PDB sidecar.
    /// Only consumed when
    /// <see cref="DebugInformation"/>.<see cref="DebugInformationOptions.Format"/>
    /// is <see cref="DebugInformationFormat.Portable"/>; ignored otherwise.
    /// </summary>
    public Stream PdbStream { get; set; }

    /// <summary>
    /// Gets or sets the Portable PDB collaborator. Instantiated by
    /// <c>EmitCore</c> when the caller requested portable or embedded PDBs;
    /// <see langword="null"/> in every other configuration so the legacy PE-
    /// only emit path stays bit-for-bit identical.
    /// </summary>
    public PortablePdbEmitter Pdb { get; set; }

    /// <summary>
    /// Gets or sets the BCL <see cref="object"/> <see cref="Type"/> resolved
    /// from the target framework's <see cref="References"/>. Set by
    /// <c>EmitCore</c> before any TypeRef rows are needed.
    /// </summary>
    public Type CoreObjectType { get; set; }

    /// <summary>
    /// Gets or sets the BCL <see cref="string"/> <see cref="Type"/> resolved
    /// from the target framework's <see cref="References"/>.
    /// </summary>
    public Type CoreStringType { get; set; }

    /// <summary>
    /// Gets or sets the BCL <see cref="int"/>
    /// <see cref="Type"/> resolved from the target framework's
    /// <see cref="References"/>.
    /// </summary>
    public Type CoreInt32Type { get; set; }

    /// <summary>
    /// Gets or sets the BCL <see cref="bool"/> <see cref="Type"/> resolved
    /// from the target framework's <see cref="References"/>.
    /// </summary>
    public Type CoreBooleanType { get; set; }

    /// <summary>
    /// Gets or sets the BCL <see cref="Array"/> <see cref="Type"/> resolved
    /// from the target framework's <see cref="References"/>.
    /// </summary>
    public Type CoreArrayType { get; set; }

    /// <summary>
    /// Gets or sets the BCL <see cref="ValueType"/> <see cref="Type"/> resolved
    /// from the target framework's <see cref="References"/>.
    /// </summary>
    public Type CoreValueType { get; set; }

    /// <summary>
    /// Gets or sets the BCL <see cref="System.Type"/> reflection-info type
    /// resolved from the target framework's <see cref="References"/>.
    /// </summary>
    public Type CoreSystemType { get; set; }

    /// <summary>
    /// Gets or sets the BCL <see cref="RuntimeTypeHandle"/> type resolved from
    /// the target framework's <see cref="References"/>.
    /// </summary>
    public Type CoreRuntimeTypeHandleType { get; set; }

    /// <summary>
    /// Gets or sets the BCL <see cref="System.RuntimeMethodHandle"/> type
    /// resolved from the target framework's <see cref="References"/>.
    /// Issue #2373: backs emission of a <see cref="System.Reflection.MethodInfo"/>
    /// runtime constant (<c>ldtoken method ; call
    /// MethodBase.GetMethodFromHandle</c>) for expression-tree lowering's CLR
    /// operator-method arguments.
    /// </summary>
    public Type CoreRuntimeMethodHandleType { get; set; }

    /// <summary>
    /// Gets or sets the BCL <see cref="System.Reflection.MethodBase"/> type
    /// resolved from the target framework's <see cref="References"/>. See
    /// <see cref="CoreRuntimeMethodHandleType"/>.
    /// </summary>
    public Type CoreMethodBaseType { get; set; }

    /// <summary>
    /// Gets or sets the BCL <see cref="Enum"/> type resolved from the target
    /// framework's <see cref="References"/>.
    /// </summary>
    public Type CoreEnumType { get; set; }

    /// <summary>
    /// Gets or sets the BCL <see cref="MulticastDelegate"/> type resolved from
    /// the target framework's <see cref="References"/>. Used as the base type
    /// for user-declared named delegate emission (ADR-0059 / issue #255).
    /// </summary>
    public Type CoreMulticastDelegateType { get; set; }

    /// <summary>
    /// Gets or sets the BCL <see cref="IntPtr"/> type resolved from the
    /// target framework's <see cref="References"/>. Used as the second
    /// parameter type on synthesized delegate constructors.
    /// </summary>
    public Type CoreIntPtrType { get; set; }
}
