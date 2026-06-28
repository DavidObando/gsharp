// <copyright file="ReflectionMetadataEmitter.Metadata.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>
#pragma warning disable // Split partial file preserves original layout
#pragma warning disable SA1028 // trailing whitespace
#pragma warning disable SA1116 // parameters begin on line after declaration
#pragma warning disable SA1117 // parameters on same line
#pragma warning disable SA1214 // readonly fields before non-readonly
#pragma warning disable SA1515 // single-line comment preceded by blank line
#pragma warning disable SA1201 // method should not follow a class (this file mixes private helper classes inline with methods)
#pragma warning disable SA1202 // 'internal' members should come before 'private' members (PR-E-5: IsValueTypeSymbol was widened to internal in-place for ConversionEmitter; ordering is restored once Phase 2 decomposition finishes)
#pragma warning disable SA1304 // non-private readonly field naming — PR-E-11 widened several emitter-internal fields to internal so the promoted MethodBodyEmitter can read them; ordering/casing restored after E-12 root thinning
#pragma warning disable SA1307 // field naming casing — same as SA1304
#pragma warning disable SA1401 // field should be private — same as SA1304
#pragma warning disable SA1611 // parameter documentation missing — PR-E-11 widened internal helpers used by MethodBodyEmitter; existing call-site comments document them
#pragma warning disable SA1615 // return-value documentation missing — same as SA1611

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Lowering;
using GSharp.Core.CodeAnalysis.Lowering.Async;
using GSharp.Core.CodeAnalysis.Lowering.Iterators;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;

namespace GSharp.Core.CodeAnalysis.Emit;

/// <summary>
/// Emits a managed PE for a <see cref="BoundProgram"/> using
/// <see cref="System.Reflection.Metadata"/> directly.
/// </summary>
/// <remarks>
/// Phase 2 (p2-langcov) coverage: locals, parameters, unary/binary operators,
/// assignments, label/goto/conditional-goto, user-defined function calls
/// (emitted as static methods on <c>&lt;Program&gt;</c>), and the imported-call
/// surface inherited from Phase 1. Per ADR-0027 the bespoke emitter is the
/// production path for v1.0; the Roslyn-fork escape valve referenced in
/// earlier comments here has been removed from the tree.
/// </remarks>

internal sealed partial class ReflectionMetadataEmitter
{


    /// <summary>
    /// Emits <paramref name="program"/> to <paramref name="peStream"/> as a
    /// managed PE.
    /// </summary>
    /// <param name="program">The bound program to emit.</param>
    /// <param name="peStream">Destination stream for the PE bytes.</param>
    /// <param name="references">
    /// Reference resolver providing the target framework's core types
    /// (<c>System.Object</c>, <c>System.String</c>) and any user-supplied
    /// imports. Pass <c>null</c> to resolve from the gsc host's loaded
    /// runtime (in-process scenarios only — produces an assembly bound to
    /// the gsc host's TFM).
    /// </param>
    /// <param name="assemblyName">
    /// Optional override for the assembly identity (module + assembly rows).
    /// When <c>null</c>, the entry-point package's name is used. Supplied by
    /// the SDK BuildTask from MSBuild's <c>AssemblyName</c>.
    /// </param>
    /// <param name="metadataOnly">
    /// When true, emits a metadata-only reference assembly: method bodies
    /// are omitted (RVA 0) and the assembly is marked with
    /// <c>System.Runtime.CompilerServices.ReferenceAssemblyAttribute</c>.
    /// </param>
    /// <param name="asyncRewriteResult">
    /// Optional result from the async state-machine rewriter. When non-null,
    /// contains plans for emitting state-machine types and kickoff bodies.
    /// </param>
    /// <param name="iteratorRewriteResult">
    /// Optional result from the iterator rewriter. When non-null, contains plans
    /// for emitting iterator state-machine types and kickoff bodies.
    /// </param>
    /// <param name="asyncIteratorRewriteResult">
    /// Optional result from the async iterator rewriter. When non-null, contains plans
    /// for emitting async iterator state-machine types and kickoff bodies.
    /// </param>
    /// <param name="debugInformation">
    /// Phase 3 (ADR-0027 §7.7a) PDB-related emit options. When <see langword="null"/>
    /// or when <see cref="DebugInformationOptions.Format"/> is
    /// <see cref="DebugInformationFormat.None"/> the emitter behaves exactly as
    /// it did before Phase 3 (no PDB sidecar, no <c>DebugDirectory</c> entries).
    /// The actual production of PDB content lands across Phases 4–7; Phase 3
    /// only plumbs the option onto the emitter so subsequent phases can consume
    /// it without further signature churn.
    /// </param>
    /// <param name="pdbStream">
    /// Optional destination for the Portable PDB sidecar stream. Only consumed
    /// when <paramref name="debugInformation"/> requests
    /// <see cref="DebugInformationFormat.Portable"/>; ignored in every other
    /// configuration. Plumbed here so callers can open the file once and have
    /// the emitter write to it directly without intermediate buffering.
    /// </param>
    /// <param name="assemblyVersion">
    /// Optional informational version string. When non-null, emitted as
    /// <c>AssemblyInformationalVersionAttribute</c> on the assembly so NuGet
    /// and consumer tooling can display the package version.
    /// </param>
    public static void Emit(
        BoundProgram program,
        Stream peStream,
        ReferenceResolver references = null,
        string assemblyName = null,
        bool metadataOnly = false,
        AsyncStateMachineRewriteResult asyncRewriteResult = null,
        IteratorRewriteResult iteratorRewriteResult = null,
        Lowering.Iterators.AsyncIteratorRewriteResult asyncIteratorRewriteResult = null,
        DebugInformationOptions debugInformation = null,
        Stream pdbStream = null,
        string assemblyVersion = null)
    {
        var emitter = new ReflectionMetadataEmitter(program, references, assemblyName, metadataOnly);
        emitter.emitCtx.AssemblyVersionOverride = assemblyVersion;

        emitter.emitCtx.DebugInformation = debugInformation ?? new DebugInformationOptions();
        emitter.emitCtx.PdbStream = pdbStream;

        emitter.EmitCore(peStream, asyncRewriteResult, iteratorRewriteResult, asyncIteratorRewriteResult);
    }private void EmitCore( Stream peStream, AsyncStateMachineRewriteResult asyncRewriteResult = null, IteratorRewriteResult iteratorRewriteResult = null,
Lowering.Iterators.AsyncIteratorRewriteResult asyncIteratorRewriteResult = null) { var format = this.emitCtx.DebugInformation.Format; var needsPdb = (format == DebugInformationFormat.Portable && this.emitCtx.PdbStream != null)
|| format == DebugInformationFormat.Embedded; if (needsPdb) { this.emitCtx.Pdb = new PortablePdbEmitter(this.emitCtx.DebugInformation);
var importsGrouped = new Dictionary<SyntaxTree, ImmutableArray<ImportSymbol>>(); foreach (var import in this.emitCtx.Program.Imports) { var tree = import.Declaration?.SyntaxTree;
if (tree is null) { continue; }
if (!importsGrouped.TryGetValue(tree, out var list)) { list = ImmutableArray<ImportSymbol>.Empty; }
importsGrouped[tree] = list.Add(import); } this.emitCtx.Pdb.SetImportsPerTree(importsGrouped); this.emitCtx.Pdb.SetReferenceInfos(this.emitCtx.References.GetReferenceInfos());
} this.emitCtx.CoreObjectType = this.ResolveCoreType("System.Object", typeof(object)); this.emitCtx.CoreStringType = this.ResolveCoreType("System.String", typeof(string)); this.emitCtx.CoreInt32Type = this.ResolveCoreType("System.Int32", typeof(int));
this.emitCtx.CoreBooleanType = this.ResolveCoreType("System.Boolean", typeof(bool)); this.emitCtx.CoreArrayType = this.ResolveCoreType("System.Array", typeof(System.Array)); this.emitCtx.CoreValueType = this.ResolveCoreType("System.ValueType", typeof(System.ValueType)); this.emitCtx.CoreSystemType = this.ResolveCoreType("System.Type", typeof(System.Type));
this.emitCtx.CoreRuntimeTypeHandleType = this.ResolveCoreType("System.RuntimeTypeHandle", typeof(System.RuntimeTypeHandle)); this.emitCtx.CoreEnumType = this.ResolveCoreType("System.Enum", typeof(System.Enum)); this.emitCtx.CoreMulticastDelegateType = this.ResolveCoreType("System.MulticastDelegate", typeof(System.MulticastDelegate)); this.emitCtx.CoreIntPtrType = this.ResolveCoreType("System.IntPtr", typeof(System.IntPtr));
this.wellKnown = new WellKnownReferences(this.emitCtx, this.GetTypeReference, this.GetMethodReference); this.customAttrEncoder = new CustomAttributeEncoder(this.emitCtx, this.wellKnown, this.GetTypeReference); this.methodBodyPlanner = new MethodBodyPlanner( this.emitCtx,
this.cache, this.slotPlanner, this.lambdaBodies, this.GetTypeReference,
this.GetTypeHandleForMember, this.EncodeTypeSymbol); this.conversionEmitter = new ConversionEmitter(this.emitCtx, this.cache, this.wellKnown, this.GetElementTypeToken); this.dataStructSynth = new DataStructSynthesizer(
this.emitCtx, this.cache, this.wellKnown, this.conversionEmitter,
this.EncodeTypeSymbol, this.GetElementTypeToken, this.GetTypeReference, this.customAttrEncoder.NextParameterHandle,
this.ResolveUserTypeToken, this.ResolveFieldToken, this.GetUserStructMethodRef); this.memberDefEmitter = new MemberDefEmitter(
this.emitCtx, this.cache, this.wellKnown, this.EmitFunction,
this.EncodeTypeSymbol, this.customAttrEncoder.NextParameterHandle, this.GetTypeReference, this.GetTypeHandleForMember,
this.ResolveFieldToken); this.typeDefEmitter = new TypeDefEmitter( this.emitCtx, this.cache,
this.wellKnown, this.EncodeTypeSymbol, this.EncodeReturnSymbol, this.GetTypeReference,
this.GetUserStructTypeSpec, this.ResolveConstructedBaseParameterlessCtorToken, this.ResolveConstructedBaseExplicitCtorToken, this.customAttrEncoder.NextParameterHandle,
this.customAttrEncoder.EmitUserAttributes, this.customAttrEncoder.EmitIsReadOnlyAttributeOnParameter, this.customAttrEncoder.EmitParamArrayAttributeOnParameter, this.GetCtorReference,
this.EmitStaticConstructorBodyBytes, this.EmitClassDefaultConstructorBodyBytes, this.EmitClassPrimaryConstructorBodyBytes, this.EmitClassConstructorWithBaseInitializerBodyBytes,
this.EmitClassConstructorWithBodyBodyBytes, this.EmitClassDeinitializerBodyBytes); this.closures = new ClosureEmitter( this.emitCtx,
this.cache, this.wellKnown, this.slotPlanner, this.lambdaBodies);
this.stateMachines = new StateMachineEmitter( this.emitCtx, this.cache, this.wellKnown,
this.closures, this.lambdaBodies, this.GetTypeReference, this.GetTypeHandleForMember,
this.GetMethodEntityHandle, this.GetMethodEntityHandle, this.GetMethodReference, this.customAttrEncoder.NextParameterHandle,
this.EncodeTypeSymbol, this.EncodeClrType, this.BuildMoveNextBodyBytes); if (asyncRewriteResult != null)
{ this.stateMachines.AsyncStateMachinePlans = asyncRewriteResult.StateMachines; } if (iteratorRewriteResult != null)
{ this.stateMachines.IteratorPlans = iteratorRewriteResult.Plans; } if (asyncIteratorRewriteResult != null)
{ this.stateMachines.AsyncIteratorPlans = asyncIteratorRewriteResult.Plans; } this.methodBodyPlanner.SetStateMachines(this.stateMachines);
var lambdaLiterals = this.methodBodyPlanner.CollectFunctionLiterals(); var goStatements = this.methodBodyPlanner.CollectGoStatements(); var hostPackageGuess = this.emitCtx.Program.EntryPoint?.Package ?? this.emitCtx.Program.EntryPointPackage
?? (this.emitCtx.Program.Packages.IsDefaultOrEmpty ? null : this.emitCtx.Program.Packages[0]); this.closures.SynthesizeClosures(lambdaLiterals, hostPackageGuess); this.closures.SynthesizeGoClosures(goStatements, hostPackageGuess); this.stateMachines.SynthesizeIteratorStateMachines(hostPackageGuess);
this.stateMachines.SynthesizeAsyncIteratorStateMachines(hostPackageGuess); this.stateMachines.SynthesizeAsyncLambdaStateMachines(lambdaLiterals, hostPackageGuess); foreach (var kvp in this.stateMachines.IteratorStateMachineInfos) {
var remap = kvp.Value.BuildRemap(); if (remap != null) { this.iteratorStateMachineRemapsByClass[kvp.Key] = remap;
} } var allAggregates = this.emitCtx.Program.Structs; if (this.closures.SynthesizedClosureClasses.Count > 0)
{ allAggregates = allAggregates.AddRange(this.closures.SynthesizedClosureClasses); } var asyncSmStructs = new List<StructSymbol>();
var asyncSmPlansByStruct = new Dictionary<StructSymbol, AsyncStateMachinePlan>(); foreach (var plan in this.stateMachines.AsyncStateMachinePlans) { var smStruct = plan.StateMachine.MaterializeAsStructSymbol();
asyncSmStructs.Add(smStruct); asyncSmPlansByStruct[smStruct] = plan; } if (asyncSmStructs.Count > 0)
{ allAggregates = allAggregates.AddRange(asyncSmStructs); } var smClassSet = new HashSet<StructSymbol>(
this.stateMachines.IteratorStateMachineInfos.Keys.Concat(this.stateMachines.AsyncIteratorInfos.Keys)); var smStructSet = new HashSet<StructSymbol>(asyncSmStructs); var nonSmClasses = new List<StructSymbol>(); var smClasses = new List<StructSymbol>();
var nonSmStructs = new List<StructSymbol>(); var smStructsOrdered = new List<StructSymbol>(); foreach (var s in allAggregates) {
if (s.IsClass) { if (smClassSet.Contains(s)) {
smClasses.Add(s); } else {
nonSmClasses.Add(s); } } else
{ if (smStructSet.Contains(s)) { smStructsOrdered.Add(s);
} else { nonSmStructs.Add(s);
} } } var interfaces = this.emitCtx.Program.Interfaces;
var enumsAll = this.emitCtx.Program.Enums; static bool IsUserNested(TypeSymbol t) => t switch { StructSymbol ss => ss.ContainingType != null,
EnumSymbol es => es.ContainingType != null, InterfaceSymbol ifs => ifs.ContainingType != null, _ => false, };
static TypeSymbol ContainingOf(TypeSymbol t) => t switch { StructSymbol ss => ss.ContainingType, EnumSymbol es => es.ContainingType,
InterfaceSymbol ifs => ifs.ContainingType, _ => null, }; var topInterfaces = interfaces.Where(i => !IsUserNested(i)).ToList();
var topClasses = nonSmClasses.Where(c => !IsUserNested(c)).ToList(); var topStructs = nonSmStructs.Where(s => !IsUserNested(s)).ToList(); var topEnums = enumsAll.Where(e => !IsUserNested(e)).ToList(); var nestedChildrenByParent = new Dictionary<TypeSymbol, List<TypeSymbol>>();
void RegisterNestedChild(TypeSymbol child) { var parent = ContainingOf(child); if (parent == null)
{ return; } if (!nestedChildrenByParent.TryGetValue(parent, out var list))
{ list = new List<TypeSymbol>(); nestedChildrenByParent[parent] = list; }
list.Add(child); } foreach (var i in interfaces.Where(IsUserNested)) {
RegisterNestedChild(i); } foreach (var c in nonSmClasses.Where(IsUserNested)) {
RegisterNestedChild(c); } foreach (var s in nonSmStructs.Where(IsUserNested)) {
RegisterNestedChild(s); } foreach (var e in enumsAll.Where(IsUserNested)) {
RegisterNestedChild(e); } var nestedOrdered = new List<TypeSymbol>(); void VisitNested(TypeSymbol parent)
{ if (!nestedChildrenByParent.TryGetValue(parent, out var children)) { return;
} foreach (var child in children) { nestedOrdered.Add(child);
VisitNested(child); } } foreach (var i in topInterfaces)
{ VisitNested(i); } foreach (var c in topClasses)
{ VisitNested(c); } foreach (var s in topStructs)
{ VisitNested(s); } foreach (var e in topEnums)
{ VisitNested(e); } var nestedFieldListRow = new Dictionary<TypeSymbol, int>();
var nestedMethodListRow = new Dictionary<TypeSymbol, int>(); int nextFieldRow = 1; var interfaceFirstFieldRow = new Dictionary<InterfaceSymbol, int>(); foreach (var i in topInterfaces)
{ interfaceFirstFieldRow[i] = nextFieldRow; nextFieldRow += i.StaticFields.Length + i.ConstFields.Length; }
var structFirstFieldRow = new Dictionary<StructSymbol, int>(); void PlanAggregateFields(StructSymbol s) { structFirstFieldRow[s] = nextFieldRow;
nextFieldRow += s.Fields.Length; foreach (var p in s.Properties) { if (p.IsAutoProperty && p.BackingField != null && !s.Fields.Contains(p.BackingField))
{ nextFieldRow++; } }
foreach (var ev in s.Events) { if (ev.IsFieldLike && ev.BackingField != null) {
nextFieldRow++; } } if (!s.StaticFields.IsDefaultOrEmpty)
{ nextFieldRow += s.StaticFields.Length; } if (!s.ConstFields.IsDefaultOrEmpty)
{ nextFieldRow += s.ConstFields.Length; } foreach (var p in s.StaticProperties)
{ if (p.IsAutoProperty && p.BackingField != null) { nextFieldRow++;
} } foreach (var ev in s.StaticEvents) {
if (ev.IsFieldLike && ev.BackingField != null) { nextFieldRow++; }
} } var enums = enumsAll; var enumFirstFieldRow = new Dictionary<EnumSymbol, int>();
void PlanEnumFields(EnumSymbol e) { enumFirstFieldRow[e] = nextFieldRow; nextFieldRow += 1 + e.Members.Length;
} foreach (var s in topClasses) { PlanAggregateFields(s);
} foreach (var s in topStructs) { PlanAggregateFields(s);
} foreach (var e in topEnums) { PlanEnumFields(e);
} foreach (var nested in nestedOrdered) { nestedFieldListRow[nested] = nextFieldRow;
switch (nested) { case StructSymbol ns: PlanAggregateFields(ns);
break; case EnumSymbol ne: PlanEnumFields(ne); break;
case InterfaceSymbol ni: interfaceFirstFieldRow[ni] = nextFieldRow; nextFieldRow += ni.StaticFields.Length + ni.ConstFields.Length; break;
} } var globals = this.emitCtx.Program.Globals; int programFirstFieldRow = nextFieldRow;
var globalFieldRows = new Dictionary<GlobalVariableSymbol, int>(); foreach (var g in globals) { globalFieldRows[g] = nextFieldRow++;
} foreach (var s in smClasses) { structFirstFieldRow[s] = nextFieldRow;
nextFieldRow += s.Fields.Length; } foreach (var s in smStructsOrdered) {
structFirstFieldRow[s] = nextFieldRow; nextFieldRow += s.Fields.Length; } var moduleFirstFieldRow = 1;
int methodRow = 1; var interfaceFirstMethodRow = new Dictionary<InterfaceSymbol, int>(); var interfaceCctorRows = new Dictionary<InterfaceSymbol, int>(); void PlanInterfaceMethods(InterfaceSymbol i)
{ interfaceFirstMethodRow[i] = methodRow; foreach (var m in i.Methods) {
this.cache.MethodHandles[m] = MetadataTokens.MethodDefinitionHandle(methodRow++); } foreach (var sm in i.StaticMethods) {
this.cache.MethodHandles[sm] = MetadataTokens.MethodDefinitionHandle(methodRow++); } if (!i.PrivateMethods.IsDefaultOrEmpty) {
foreach (var pm in i.PrivateMethods) { this.cache.MethodHandles[pm] = MetadataTokens.MethodDefinitionHandle(methodRow++); }
} if (!i.StaticPrivateMethods.IsDefaultOrEmpty) { foreach (var spm in i.StaticPrivateMethods)
{ this.cache.MethodHandles[spm] = MetadataTokens.MethodDefinitionHandle(methodRow++); } }
foreach (var prop in i.Properties) { MethodDefinitionHandle? getterHandle = null; MethodDefinitionHandle? setterHandle = null;
if (prop.HasGetter) { getterHandle = MetadataTokens.MethodDefinitionHandle(methodRow++); }
if (prop.HasSetter) { setterHandle = MetadataTokens.MethodDefinitionHandle(methodRow++); }
this.cache.PropertyAccessorHandles[prop] = (getterHandle, setterHandle); if (prop.IsStatic) { if (prop.GetterSymbol != null && getterHandle.HasValue)
{ this.cache.MethodHandles[prop.GetterSymbol] = getterHandle.Value; } if (prop.SetterSymbol != null && setterHandle.HasValue)
{ this.cache.MethodHandles[prop.SetterSymbol] = setterHandle.Value; } }
} foreach (var ev in i.Events) { var addHandle = MetadataTokens.MethodDefinitionHandle(methodRow++);
var removeHandle = MetadataTokens.MethodDefinitionHandle(methodRow++); MethodDefinitionHandle? raiseHandle = ev.RaiseMethodSymbol != null ? MetadataTokens.MethodDefinitionHandle(methodRow++) : null; this.cache.EventAccessorHandles[ev] = (addHandle, removeHandle, raiseHandle); }
if (!i.StaticFieldInitializers.IsEmpty) { interfaceCctorRows[i] = methodRow++; }
} foreach (var i in topInterfaces) { PlanInterfaceMethods(i);
} var delegates = this.emitCtx.Program.Delegates; var delegateCtorRows = new Dictionary<DelegateTypeSymbol, int>(); var delegateInvokeRows = new Dictionary<DelegateTypeSymbol, int>();
foreach (var d in delegates) { delegateCtorRows[d] = methodRow++; delegateInvokeRows[d] = methodRow++;
} var classCtorRows = new Dictionary<StructSymbol, int>(); var classPrimaryCtorRows = new Dictionary<StructSymbol, int>(); var aggregateMethodHandles = new Dictionary<FunctionSymbol, MethodDefinitionHandle>();
void PlanClassMethods(StructSymbol c) { classCtorRows[c] = methodRow++; if (c.ExplicitConstructor != null && c.ExplicitConstructors.Length > 1)
{ methodRow += c.ExplicitConstructors.Length - 1; } if (c.HasPrimaryConstructor && c.BaseConstructorInitializer == null && c.ExplicitConstructor == null)
{ classPrimaryCtorRows[c] = methodRow++; } if (!c.Methods.IsDefaultOrEmpty)
{ foreach (var m in c.Methods) { var handle = MetadataTokens.MethodDefinitionHandle(methodRow++);
aggregateMethodHandles[m] = handle; this.cache.MethodHandles[m] = handle; } }
if (c.Deinitializer != null) { var deinitHandle = MetadataTokens.MethodDefinitionHandle(methodRow++); this.cache.MethodHandles[c.Deinitializer.Function] = deinitHandle;
} foreach (var prop in c.Properties) { MethodDefinitionHandle? getterHandle = null;
MethodDefinitionHandle? setterHandle = null; if (prop.HasGetter) { getterHandle = MetadataTokens.MethodDefinitionHandle(methodRow++);
} if (prop.HasSetter) { setterHandle = MetadataTokens.MethodDefinitionHandle(methodRow++);
} this.cache.PropertyAccessorHandles[prop] = (getterHandle, setterHandle); this.RegisterIndexerAccessorHandles(prop, getterHandle, setterHandle); }
foreach (var ev in c.Events) { var addHandle = MetadataTokens.MethodDefinitionHandle(methodRow++); var removeHandle = MetadataTokens.MethodDefinitionHandle(methodRow++);
MethodDefinitionHandle? raiseHandle = ev.RaiseMethodSymbol != null ? MetadataTokens.MethodDefinitionHandle(methodRow++) : null; this.cache.EventAccessorHandles[ev] = (addHandle, removeHandle, raiseHandle); } if (!c.StaticMethods.IsDefaultOrEmpty)
{ foreach (var m in c.StaticMethods) { var handle = MetadataTokens.MethodDefinitionHandle(methodRow++);
aggregateMethodHandles[m] = handle; this.cache.MethodHandles[m] = handle; } }
foreach (var prop in c.StaticProperties) { MethodDefinitionHandle? getterHandle = null; MethodDefinitionHandle? setterHandle = null;
if (prop.HasGetter) { getterHandle = MetadataTokens.MethodDefinitionHandle(methodRow++); }
if (prop.HasSetter) { setterHandle = MetadataTokens.MethodDefinitionHandle(methodRow++); }
this.cache.PropertyAccessorHandles[prop] = (getterHandle, setterHandle); } foreach (var ev in c.StaticEvents) {
var addHandle = MetadataTokens.MethodDefinitionHandle(methodRow++); var removeHandle = MetadataTokens.MethodDefinitionHandle(methodRow++); MethodDefinitionHandle? raiseHandle = ev.RaiseMethodSymbol != null ? MetadataTokens.MethodDefinitionHandle(methodRow++) : null; this.cache.EventAccessorHandles[ev] = (addHandle, removeHandle, raiseHandle);
} if (!c.StaticFieldInitializers.IsEmpty) { this.cache.CctorHandles[c] = MetadataTokens.MethodDefinitionHandle(methodRow++);
} } foreach (var c in topClasses) {
PlanClassMethods(c); } var structFirstMethodRows = new Dictionary<StructSymbol, int>(); void PlanStructMethods(StructSymbol s)
{ if (s.Methods.IsDefaultOrEmpty && !s.IsInline && !s.IsData && s.Properties.IsDefaultOrEmpty && s.Events.IsDefaultOrEmpty && s.StaticMethods.IsDefaultOrEmpty && s.StaticProperties.IsDefaultOrEmpty && s.StaticEvents.IsDefaultOrEmpty && s.StaticFieldInitializers.IsEmpty) { return;
} structFirstMethodRows[s] = methodRow; if (s.IsInline) {
methodRow += 8; } else if (s.IsData) {
methodRow += 7; } foreach (var m in s.Methods) {
var handle = MetadataTokens.MethodDefinitionHandle(methodRow++); aggregateMethodHandles[m] = handle; this.cache.MethodHandles[m] = handle; }
foreach (var prop in s.Properties) { MethodDefinitionHandle? getterHandle = null; MethodDefinitionHandle? setterHandle = null;
if (prop.HasGetter) { getterHandle = MetadataTokens.MethodDefinitionHandle(methodRow++); }
if (prop.HasSetter) { setterHandle = MetadataTokens.MethodDefinitionHandle(methodRow++); }
this.cache.PropertyAccessorHandles[prop] = (getterHandle, setterHandle); this.RegisterIndexerAccessorHandles(prop, getterHandle, setterHandle); } foreach (var ev in s.Events)
{ var addHandle = MetadataTokens.MethodDefinitionHandle(methodRow++); var removeHandle = MetadataTokens.MethodDefinitionHandle(methodRow++); MethodDefinitionHandle? raiseHandle = ev.RaiseMethodSymbol != null ? MetadataTokens.MethodDefinitionHandle(methodRow++) : null;
this.cache.EventAccessorHandles[ev] = (addHandle, removeHandle, raiseHandle); } if (!s.StaticMethods.IsDefaultOrEmpty) {
foreach (var m in s.StaticMethods) { var handle = MetadataTokens.MethodDefinitionHandle(methodRow++); aggregateMethodHandles[m] = handle;
this.cache.MethodHandles[m] = handle; } } foreach (var prop in s.StaticProperties)
{ MethodDefinitionHandle? getterHandle = null; MethodDefinitionHandle? setterHandle = null; if (prop.HasGetter)
{ getterHandle = MetadataTokens.MethodDefinitionHandle(methodRow++); } if (prop.HasSetter)
{ setterHandle = MetadataTokens.MethodDefinitionHandle(methodRow++); } this.cache.PropertyAccessorHandles[prop] = (getterHandle, setterHandle);
} foreach (var ev in s.StaticEvents) { var addHandle = MetadataTokens.MethodDefinitionHandle(methodRow++);
var removeHandle = MetadataTokens.MethodDefinitionHandle(methodRow++); MethodDefinitionHandle? raiseHandle = ev.RaiseMethodSymbol != null ? MetadataTokens.MethodDefinitionHandle(methodRow++) : null; this.cache.EventAccessorHandles[ev] = (addHandle, removeHandle, raiseHandle); }
if (!s.StaticFieldInitializers.IsEmpty) { this.cache.CctorHandles[s] = MetadataTokens.MethodDefinitionHandle(methodRow++); }
} foreach (var s in topStructs) { PlanStructMethods(s);
} int firstNestedMethodRow = methodRow; foreach (var nested in nestedOrdered) {
nestedMethodListRow[nested] = methodRow; switch (nested) { case InterfaceSymbol ni:
PlanInterfaceMethods(ni); break; case StructSymbol ns when ns.IsClass: PlanClassMethods(ns);
break; case StructSymbol ns: PlanStructMethods(ns); break;
} } int firstPackageCtorRow = methodRow; this.emitCtx.Metadata.AddTypeDefinition(
attributes: default(TypeAttributes), @namespace: default(StringHandle), name: this.emitCtx.Metadata.GetOrAddString("<Module>"), baseType: default(EntityHandle),
fieldList: MetadataTokens.FieldDefinitionHandle(moduleFirstFieldRow), methodList: MetadataTokens.MethodDefinitionHandle(1)); int reservedTypeDefRow = this.emitCtx.Metadata.GetRowCount(TableIndex.TypeDef) + 1; void ReserveTypeDefHandle(TypeSymbol type)
{ var handle = MetadataTokens.TypeDefinitionHandle(reservedTypeDefRow++); switch (type) {
case InterfaceSymbol ifaceSym: this.cache.InterfaceTypeDefs[ifaceSym] = handle; break; case DelegateTypeSymbol delegateSym:
this.cache.DelegateTypeDefs[delegateSym] = handle; break; case StructSymbol structSym: this.cache.StructTypeDefs[structSym] = handle;
break; case EnumSymbol enumSym: this.cache.EnumTypeDefs[enumSym] = handle; break;
} } foreach (var i in topInterfaces) {
ReserveTypeDefHandle(i); } foreach (var d in delegates) {
ReserveTypeDefHandle(d); } foreach (var c in topClasses) {
ReserveTypeDefHandle(c); } foreach (var s in topStructs) {
ReserveTypeDefHandle(s); } foreach (var e in topEnums) {
ReserveTypeDefHandle(e); } foreach (var nested in nestedOrdered) {
ReserveTypeDefHandle(nested); } foreach (var i in topInterfaces) {
this.typeDefEmitter.EmitInterfaceTypeDef(i, interfaceFirstMethodRow[i], interfaceFirstFieldRow[i]); } void EmitInterfaceBaseImplRows(InterfaceSymbol iface) {
if (!this.cache.InterfaceTypeDefs.TryGetValue(iface, out var ifaceTypeDef)) { return; }
if (!iface.BaseInterfaces.IsDefaultOrEmpty) { foreach (var baseIface in iface.BaseInterfaces) {
if (ReflectionMetadataEmitter.IsUserGenericInterfaceReference(baseIface)) { this.emitCtx.Metadata.AddInterfaceImplementation( ifaceTypeDef,
this.GetUserInterfaceTypeSpec(baseIface)); } else if (this.cache.InterfaceTypeDefs.TryGetValue(baseIface, out var baseHandle)) {
this.emitCtx.Metadata.AddInterfaceImplementation(ifaceTypeDef, baseHandle); } } }
if (!iface.BaseClrInterfaces.IsDefaultOrEmpty) { foreach (var clrBase in iface.BaseClrInterfaces) {
if (clrBase?.ClrType is System.Type clrType) { this.emitCtx.Metadata.AddInterfaceImplementation( ifaceTypeDef,
this.GetTypeHandleForMember(clrType)); } } }
} foreach (var i in topInterfaces) { EmitInterfaceBaseImplRows(i);
} foreach (var d in delegates) { this.typeDefEmitter.EmitDelegateTypeDef(d, delegateCtorRows[d]);
} void EmitClassTypeDefRow(StructSymbol c) { this.typeDefEmitter.EmitStructTypeDef(c, structFirstFieldRow[c], classCtorRows[c]);
EmitInterfaceImplRows(c); } void EmitInterfaceImplRows(StructSymbol c) {
if (!c.Interfaces.IsDefaultOrEmpty) { foreach (var iface in c.Interfaces) {
if (ReflectionMetadataEmitter.IsUserGenericInterfaceReference(iface)) { this.emitCtx.Metadata.AddInterfaceImplementation( this.cache.StructTypeDefs[c],
this.GetUserInterfaceTypeSpec(iface)); } else if (this.cache.InterfaceTypeDefs.TryGetValue(iface, out var ifaceHandle)) {
this.emitCtx.Metadata.AddInterfaceImplementation(this.cache.StructTypeDefs[c], ifaceHandle); } } }
if (!c.ImplementedClrInterfaces.IsDefaultOrEmpty) { foreach (var ifaceSym in c.ImplementedClrInterfaces) {
if (MemberLookup.TryGetSymbolicClrGenericInterface(ifaceSym, out _, out _)) { this.emitCtx.Metadata.AddInterfaceImplementation( this.cache.StructTypeDefs[c],
this.GetElementTypeToken(ifaceSym)); continue; } if (ifaceSym?.ClrType is System.Type clrIface)
{ this.emitCtx.Metadata.AddInterfaceImplementation( this.cache.StructTypeDefs[c], this.GetTypeHandleForMember(clrIface));
} } } if (!c.Methods.IsDefaultOrEmpty)
{ System.Collections.Generic.HashSet<System.Type> bridgeInterfaces = null; foreach (var method in c.Methods) {
var declaringIface = method.ExplicitInterfaceSlot?.DeclaringType; if (declaringIface == null) { continue;
} bridgeInterfaces ??= new System.Collections.Generic.HashSet<System.Type>(); if (bridgeInterfaces.Add(declaringIface)) {
this.emitCtx.Metadata.AddInterfaceImplementation( this.cache.StructTypeDefs[c], this.GetTypeHandleForMember(declaringIface)); }
} } } int TopStructMethodListRow(StructSymbol s)
{ if (structFirstMethodRows.TryGetValue(s, out var firstStructMethodRow)) { return firstStructMethodRow;
} var methodListRow = firstNestedMethodRow; bool foundSelf = false; foreach (var s2 in topStructs)
{ if (ReferenceEquals(s2, s)) { foundSelf = true;
continue; } if (foundSelf && structFirstMethodRows.TryGetValue(s2, out var nextMethodRow)) {
methodListRow = nextMethodRow; break; } }
return methodListRow; } foreach (var c in topClasses) {
EmitClassTypeDefRow(c); } foreach (var s in topStructs) {
this.typeDefEmitter.EmitStructTypeDef(s, structFirstFieldRow[s], TopStructMethodListRow(s)); EmitInterfaceImplRows(s); } foreach (var e in topEnums)
{ this.typeDefEmitter.EmitEnumTypeDef(e, enumFirstFieldRow[e], firstNestedMethodRow); } foreach (var nested in nestedOrdered)
{ switch (nested) { case InterfaceSymbol ni:
this.typeDefEmitter.EmitInterfaceTypeDef(ni, interfaceFirstMethodRow[ni], nestedFieldListRow[ni]); EmitInterfaceBaseImplRows(ni); break; case StructSymbol ns when ns.IsClass:
EmitClassTypeDefRow(ns); break; case StructSymbol ns: this.typeDefEmitter.EmitStructTypeDef(ns, structFirstFieldRow[ns], nestedMethodListRow[ns]);
EmitInterfaceImplRows(ns); break; case EnumSymbol ne: this.typeDefEmitter.EmitEnumTypeDef(ne, enumFirstFieldRow[ne], nestedMethodListRow[ne]);
break; } } var packages = this.emitCtx.Program.Packages.IsDefaultOrEmpty
? ImmutableArray.Create(this.emitCtx.Program.EntryPointPackage ?? new PackageSymbol("Default", declaration: null)) : this.emitCtx.Program.Packages; var functionsByPackage = new Dictionary<PackageSymbol, List<FunctionSymbol>>(); foreach (var pkg in packages)
{ functionsByPackage[pkg] = new List<FunctionSymbol>(); } foreach (var kvp in this.emitCtx.Program.Functions)
{ if (kvp.Key == this.emitCtx.Program.EntryPoint) { continue;
} if (kvp.Key.IsInstanceMethod) { continue;
} if (kvp.Key.IsStatic && aggregateMethodHandles.ContainsKey(kvp.Key)) { continue;
} if (kvp.Key.IsStatic && kvp.Key.StaticOwnerType is InterfaceSymbol) { continue;
} var owningPackage = kvp.Key.Package ?? this.emitCtx.Program.EntryPointPackage ?? packages[0]; if (!functionsByPackage.TryGetValue(owningPackage, out var bucket)) {
bucket = new List<FunctionSymbol>(); functionsByPackage[owningPackage] = bucket; packages = packages.Add(owningPackage); }
bucket.Add(kvp.Key); } var entryPointPackage = this.emitCtx.Program.EntryPoint?.Package ?? this.emitCtx.Program.EntryPointPackage; foreach (var pkgKey in functionsByPackage.Keys.ToList())
{ functionsByPackage[pkgKey].Sort(FunctionEmitOrderComparer.Instance); } var lambdaHostPackage = entryPointPackage ?? packages[0];
if (lambdaLiterals.Count > 0) { if (!functionsByPackage.TryGetValue(lambdaHostPackage, out var hostBucket)) {
hostBucket = new List<FunctionSymbol>(); functionsByPackage[lambdaHostPackage] = hostBucket; packages = packages.Add(lambdaHostPackage); }
foreach (var literal in lambdaLiterals) { if (literal.CapturedVariables.Length > 0) {
continue; } this.lambdaBodies[literal.Function] = (BoundBlockStatement)Lowerer.Lower(literal.Body); hostBucket.Add(literal.Function);
} } var packageCtorRows = new Dictionary<PackageSymbol, int>(); var nextRow = firstPackageCtorRow;
foreach (var pkg in packages) { packageCtorRows[pkg] = nextRow++; foreach (var fn in functionsByPackage[pkg])
{ this.cache.FunctionHandles[fn] = MetadataTokens.MethodDefinitionHandle(nextRow++); if (fn.IsPInvoke && fn.PInvokeMetadata.IsLibraryImport) {
this.cache.LibraryImportInnerHandles[fn] = MetadataTokens.MethodDefinitionHandle(nextRow++); } } if (this.emitCtx.Program.EntryPoint is not null && pkg == entryPointPackage)
{ this.cache.FunctionHandles[this.emitCtx.Program.EntryPoint] = MetadataTokens.MethodDefinitionHandle(nextRow++); } }
int firstSmClassMethodRow = nextRow; foreach (var c in smClasses) { classCtorRows[c] = nextRow++;
if (c.HasPrimaryConstructor) { classPrimaryCtorRows[c] = nextRow++; }
if (!c.Methods.IsDefaultOrEmpty) { foreach (var m in c.Methods) {
var handle = MetadataTokens.MethodDefinitionHandle(nextRow++); aggregateMethodHandles[m] = handle; this.cache.MethodHandles[m] = handle; }
} } foreach (var s in smStructsOrdered) {
structFirstMethodRows[s] = nextRow; nextRow += 2; } MethodDefinitionHandle entryHandle = default;
if (this.emitCtx.Program.EntryPoint is not null) { entryHandle = this.cache.FunctionHandles[this.emitCtx.Program.EntryPoint]; }
foreach (var c in smClasses) { this.cache.ClassCtorHandles[c] = MetadataTokens.MethodDefinitionHandle(classCtorRows[c]); }
foreach (var c in nonSmClasses) { if (!classCtorRows.TryGetValue(c, out var firstCtorRow)) {
continue; } if (c.ExplicitConstructor != null) {
var firstHandle = MetadataTokens.MethodDefinitionHandle(firstCtorRow); for (int i = 0; i < c.ExplicitConstructors.Length; i++) { this.cache.ExplicitCtorHandles[c.ExplicitConstructors[i]] =
MetadataTokens.MethodDefinitionHandle(firstCtorRow + i); } this.cache.ClassCtorHandles[c] = firstHandle; this.cache.ClassPrimaryCtorHandles[c] = firstHandle;
} else if (c.BaseConstructorInitializer != null) { var forwardingHandle = MetadataTokens.MethodDefinitionHandle(firstCtorRow);
this.cache.ClassCtorHandles[c] = forwardingHandle; this.cache.ClassPrimaryCtorHandles[c] = forwardingHandle; } else
{ this.cache.ClassCtorHandles[c] = MetadataTokens.MethodDefinitionHandle(firstCtorRow); if (c.HasPrimaryConstructor && classPrimaryCtorRows.TryGetValue(c, out var primaryRow)) {
this.cache.ClassPrimaryCtorHandles[c] = MetadataTokens.MethodDefinitionHandle(primaryRow); } } }
var programTypeDefHandles = new Dictionary<PackageSymbol, TypeDefinitionHandle>(); var globalsHostPkg = entryPointPackage ?? (packages.IsDefaultOrEmpty ? null : packages[0]); if (globals.Length > 0 && globalsHostPkg != null && packages.Contains(globalsHostPkg))
{ this.methodBodyPlanner.RegisterConstructedTypeAliases(); this.EmitGlobalFieldDefs(globals); var programHandle = this.emitCtx.Metadata.AddTypeDefinition(
attributes: TypeAttributes.Class | TypeAttributes.Public | TypeAttributes.AutoLayout | TypeAttributes.AnsiClass | TypeAttributes.BeforeFieldInit | TypeAttributes.Sealed | TypeAttributes.Abstract, @namespace: this.emitCtx.Metadata.GetOrAddString(globalsHostPkg.Name),
name: this.emitCtx.Metadata.GetOrAddString("<Program>"), baseType: this.wellKnown.ObjectTypeRef, fieldList: MetadataTokens.FieldDefinitionHandle(programFirstFieldRow), methodList: MetadataTokens.MethodDefinitionHandle(packageCtorRows[globalsHostPkg]));
programTypeDefHandles[globalsHostPkg] = programHandle; } foreach (var pkg in packages) {
if (programTypeDefHandles.ContainsKey(pkg)) { continue; }
var fieldListRow = programFirstFieldRow + globals.Length; var programHandle = this.emitCtx.Metadata.AddTypeDefinition( attributes: TypeAttributes.Class | TypeAttributes.Public | TypeAttributes.AutoLayout | TypeAttributes.AnsiClass | TypeAttributes.BeforeFieldInit
| TypeAttributes.Sealed | TypeAttributes.Abstract, @namespace: this.emitCtx.Metadata.GetOrAddString(pkg.Name), name: this.emitCtx.Metadata.GetOrAddString("<Program>"), baseType: this.wellKnown.ObjectTypeRef,
fieldList: MetadataTokens.FieldDefinitionHandle(fieldListRow), methodList: MetadataTokens.MethodDefinitionHandle(packageCtorRows[pkg])); programTypeDefHandles[pkg] = programHandle; }
foreach (var pkg in packages) { if (!programTypeDefHandles.TryGetValue(pkg, out var programHandle)) {
continue; } if (!functionsByPackage.TryGetValue(pkg, out var pkgFuncs)) {
continue; } var hostsAnyExtension = false; foreach (var f in pkgFuncs)
{ if (f.IsExtension && !f.IsInstanceMethod) { hostsAnyExtension = true;
break; } } if (hostsAnyExtension)
{ this.EmitExtensionAttribute(programHandle); } }
foreach (var c in smClasses) { using (this.PushSmRemap(c)) {
this.typeDefEmitter.EmitNestedStructTypeDef(c, structFirstFieldRow[c], classCtorRows[c]); if (this.stateMachines.IteratorStateMachineInfos.TryGetValue(c, out var iteratorInfo)) { this.methodBodyPlanner.AddIteratorInterfaceImplementations(c, iteratorInfo);
} if (this.stateMachines.AsyncIteratorInfos.TryGetValue(c, out var asyncIterPlan)) { this.methodBodyPlanner.AddAsyncIteratorInterfaceImplementations(c, asyncIterPlan);
} } } foreach (var s in smStructsOrdered)
{ var smMethodListRow = structFirstMethodRows[s]; this.typeDefEmitter.EmitNestedStructTypeDef(s, structFirstFieldRow[s], smMethodListRow); var iAsyncSmType = typeof(System.Runtime.CompilerServices.IAsyncStateMachine);
var iAsyncSmRef = this.GetTypeReference(iAsyncSmType); this.emitCtx.Metadata.AddInterfaceImplementation(this.cache.StructTypeDefs[s], iAsyncSmRef); } void EmitInterfaceMethodBodies(InterfaceSymbol i)
{ foreach (var m in i.Methods) { if (InterfaceSymbol.HasDefaultBody(m)
&& this.emitCtx.Program.Functions.TryGetValue(m, out var dimBody)) { var emittedHandle = this.EmitFunction(m, dimBody, isEntryPoint: false); this.cache.MethodHandles[m] = emittedHandle;
} else { this.typeDefEmitter.EmitAbstractMethod(m);
} } foreach (var sm in i.StaticMethods) {
if (InterfaceSymbol.HasDefaultBody(sm) && this.emitCtx.Program.Functions.TryGetValue(sm, out var defBody)) { var emittedHandle = this.EmitFunction(sm, defBody, isEntryPoint: false);
this.cache.MethodHandles[sm] = emittedHandle; } else {
this.typeDefEmitter.EmitStaticVirtualMethod(sm, hasBody: false, bodyOffset: -1); } } if (!i.PrivateMethods.IsDefaultOrEmpty)
{ foreach (var pm in i.PrivateMethods) { if (this.emitCtx.Program.Functions.TryGetValue(pm, out var pBody))
{ var emittedHandle = this.EmitFunction(pm, pBody, isEntryPoint: false); this.cache.MethodHandles[pm] = emittedHandle; }
} } if (!i.StaticPrivateMethods.IsDefaultOrEmpty) {
foreach (var spm in i.StaticPrivateMethods) { if (this.emitCtx.Program.Functions.TryGetValue(spm, out var sBody)) {
var emittedHandle = this.EmitFunction(spm, sBody, isEntryPoint: false); this.cache.MethodHandles[spm] = emittedHandle; } }
} this.memberDefEmitter.EmitInterfacePropertyAccessors(i); this.memberDefEmitter.EmitInterfaceEventAccessors(i); if (!i.StaticFieldInitializers.IsEmpty)
{ this.EmitInterfaceStaticConstructor(i); } }
foreach (var i in topInterfaces) { EmitInterfaceMethodBodies(i); }
void EmitClassMethodBodies(StructSymbol c) { if (c.ExplicitConstructor != null) {
MethodDefinitionHandle firstHandle = default; var firstAssigned = false; foreach (var explicitCtor in c.ExplicitConstructors) {
MethodDefinitionHandle ctorHandle; if (explicitCtor.IsSynthesizedFromPrimaryConstructor) { if (c.BaseConstructorInitializer != null)
{ ctorHandle = this.typeDefEmitter.EmitClassConstructorWithBaseInitializer(c, c.PrimaryConstructorParameters); } else
{ ctorHandle = this.typeDefEmitter.EmitClassPrimaryConstructor(c); } }
else { ctorHandle = this.typeDefEmitter.EmitClassConstructorWithBody(c, explicitCtor); }
this.cache.ExplicitCtorHandles[explicitCtor] = ctorHandle; if (!firstAssigned) { firstHandle = ctorHandle;
firstAssigned = true; } } this.cache.ClassCtorHandles[c] = firstHandle;
this.cache.ClassPrimaryCtorHandles[c] = firstHandle; } else if (c.BaseConstructorInitializer != null) {
var ctorParams = c.HasPrimaryConstructor ? c.PrimaryConstructorParameters : ImmutableArray<ParameterSymbol>.Empty; var forwardingHandle = this.typeDefEmitter.EmitClassConstructorWithBaseInitializer(c, ctorParams);
this.cache.ClassCtorHandles[c] = forwardingHandle; this.cache.ClassPrimaryCtorHandles[c] = forwardingHandle; } else
{ var ctorHandle = this.typeDefEmitter.EmitClassDefaultConstructor(c); this.cache.ClassCtorHandles[c] = ctorHandle; if (c.HasPrimaryConstructor)
{ var primaryHandle = this.typeDefEmitter.EmitClassPrimaryConstructor(c); this.cache.ClassPrimaryCtorHandles[c] = primaryHandle; }
} if (!c.Methods.IsDefaultOrEmpty) { foreach (var m in c.Methods)
{ if (!this.emitCtx.Program.Functions.TryGetValue(m, out var body)) { body = this.lambdaBodies[m];
} var emittedHandle = this.EmitFunction(m, body, isEntryPoint: false); this.cache.MethodHandles[m] = emittedHandle; }
} if (c.Deinitializer != null && this.emitCtx.Program.Functions.TryGetValue(c.Deinitializer.Function, out var deinitBody)) {
var deinitHandle = this.typeDefEmitter.EmitClassDeinitializer(c, c.Deinitializer, deinitBody); this.cache.MethodHandles[c.Deinitializer.Function] = deinitHandle; } this.memberDefEmitter.EmitPropertyAccessors(c);
this.EmitDefaultMemberAttributeIfIndexer(c); this.memberDefEmitter.EmitEventAccessors(c); if (!c.StaticMethods.IsDefaultOrEmpty) {
foreach (var m in c.StaticMethods) { if (this.emitCtx.Program.Functions.TryGetValue(m, out var staticBody)) {
var emittedHandle = this.EmitFunction(m, staticBody, isEntryPoint: false); this.cache.MethodHandles[m] = emittedHandle; } }
} this.memberDefEmitter.EmitStaticPropertyAccessors(c); this.memberDefEmitter.EmitStaticEventAccessors(c); if (this.cache.CctorHandles.ContainsKey(c))
{ this.typeDefEmitter.EmitStaticConstructor(c); } this.EmitStaticVirtualMethodImpls(c);
this.EmitStaticVirtualPropertyMethodImpls(c); this.EmitExplicitInterfaceMethodImpls(c); } foreach (var c in topClasses)
{ EmitClassMethodBodies(c); } void EmitStructMethodBodies(StructSymbol s)
{ if (s.IsInline) { this.dataStructSynth.EmitInlineStructSynthesizedMembers(s);
} else if (s.IsData) { this.dataStructSynth.EmitDataStructSynthesizedMembers(s);
} if (s.Methods.IsDefaultOrEmpty && s.Properties.IsDefaultOrEmpty && s.Events.IsDefaultOrEmpty && s.StaticMethods.IsDefaultOrEmpty && s.StaticProperties.IsDefaultOrEmpty && s.StaticEvents.IsDefaultOrEmpty && s.StaticFieldInitializers.IsEmpty) { return;
} foreach (var m in s.Methods) { if (!this.emitCtx.Program.Functions.TryGetValue(m, out var body))
{ body = this.lambdaBodies[m]; } var emittedHandle = this.EmitFunction(m, body, isEntryPoint: false);
this.cache.MethodHandles[m] = emittedHandle; } this.memberDefEmitter.EmitPropertyAccessors(s); this.EmitDefaultMemberAttributeIfIndexer(s);
this.memberDefEmitter.EmitEventAccessors(s); if (!s.StaticMethods.IsDefaultOrEmpty) { foreach (var m in s.StaticMethods)
{ if (this.emitCtx.Program.Functions.TryGetValue(m, out var staticBody)) { var emittedHandle = this.EmitFunction(m, staticBody, isEntryPoint: false);
this.cache.MethodHandles[m] = emittedHandle; } } }
this.memberDefEmitter.EmitStaticPropertyAccessors(s); this.memberDefEmitter.EmitStaticEventAccessors(s); if (this.cache.CctorHandles.ContainsKey(s)) {
this.typeDefEmitter.EmitStaticConstructor(s); } this.EmitStaticVirtualMethodImpls(s); this.EmitStaticVirtualPropertyMethodImpls(s);
this.EmitExplicitInterfaceMethodImpls(s); } foreach (var s in topStructs) {
EmitStructMethodBodies(s); } foreach (var nested in nestedOrdered) {
switch (nested) { case InterfaceSymbol ni: EmitInterfaceMethodBodies(ni);
break; case StructSymbol ns when ns.IsClass: EmitClassMethodBodies(ns); break;
case StructSymbol ns: EmitStructMethodBodies(ns); break; }
} this.methodBodyPlanner.RegisterConstructedTypeAliases(); foreach (var pkg in packages) {
this.typeDefEmitter.EmitDefaultConstructor(); foreach (var fn in functionsByPackage[pkg]) { if (!this.emitCtx.Program.Functions.TryGetValue(fn, out var body))
{ body = this.lambdaBodies[fn]; } this.EmitFunction(fn, body, isEntryPoint: false);
} if (this.emitCtx.Program.EntryPoint is not null && pkg == entryPointPackage) { var entryBody = this.emitCtx.Program.Functions[this.emitCtx.Program.EntryPoint];
this.EmitFunction(this.emitCtx.Program.EntryPoint, entryBody, isEntryPoint: true); } } foreach (var c in smClasses)
{ using (this.PushSmRemap(c)) { var ctorHandle = this.typeDefEmitter.EmitClassDefaultConstructor(c);
this.cache.ClassCtorHandles[c] = ctorHandle; if (c.HasPrimaryConstructor) { var primaryHandle = this.typeDefEmitter.EmitClassPrimaryConstructor(c);
this.cache.ClassPrimaryCtorHandles[c] = primaryHandle; } if (!c.Methods.IsDefaultOrEmpty) {
foreach (var m in c.Methods) { if (!this.emitCtx.Program.Functions.TryGetValue(m, out var body)) {
body = this.lambdaBodies[m]; } var emittedHandle = this.EmitFunction(m, body, isEntryPoint: false); this.cache.MethodHandles[m] = emittedHandle;
} } } }
foreach (var s in smStructsOrdered) { if (asyncSmPlansByStruct.TryGetValue(s, out var smPlan)) {
this.stateMachines.EmitStateMachineMoveNext(smPlan); this.stateMachines.EmitStateMachineSetStateMachine(smPlan); } }
void AddUserNestedTypeRow(TypeSymbol nested, TypeDefinitionHandle nestedHandle) { TypeSymbol containing = nested switch {
StructSymbol ss => ss.ContainingType, EnumSymbol es => es.ContainingType, InterfaceSymbol ifs => ifs.ContainingType, _ => null,
}; if (containing is StructSymbol enclosingStruct && this.cache.StructTypeDefs.TryGetValue(enclosingStruct, out var enclosingHandle)) {
this.emitCtx.Metadata.AddNestedType(nestedHandle, enclosingHandle); } } foreach (var nested in nestedOrdered)
{ switch (nested) { case StructSymbol ns when this.cache.StructTypeDefs.TryGetValue(ns, out var nsh):
AddUserNestedTypeRow(ns, nsh); break; case EnumSymbol ne when this.cache.EnumTypeDefs.TryGetValue(ne, out var neh): AddUserNestedTypeRow(ne, neh);
break; case InterfaceSymbol ni when this.cache.InterfaceTypeDefs.TryGetValue(ni, out var nih): AddUserNestedTypeRow(ni, nih); break;
} } var hostPkg = entryPointPackage ?? (packages.IsDefaultOrEmpty ? null : packages[0]); var defaultProgramHandle = hostPkg != null && programTypeDefHandles.TryGetValue(hostPkg, out var h) ? h : default;
foreach (var c in smClasses) { var nestedHandle = this.cache.StructTypeDefs[c]; if (this.methodBodyPlanner.TryGetUserKickoffReceiverHandle(c, out var receiverEnclosing))
{ this.emitCtx.Metadata.AddNestedType(nestedHandle, receiverEnclosing); continue; }
var smPkg = this.methodBodyPlanner.GetSmPackage(c, packages, entryPointPackage); var enclosingHandle = programTypeDefHandles.TryGetValue(smPkg, out var ph) ? ph : defaultProgramHandle; this.emitCtx.Metadata.AddNestedType(nestedHandle, enclosingHandle); }
foreach (var s in smStructsOrdered) { var nestedHandle = this.cache.StructTypeDefs[s]; if (this.stateMachines.AsyncSmEnclosingClosures.TryGetValue(s, out var closureSym)
&& this.cache.StructTypeDefs.TryGetValue(closureSym, out var closureHandle)) { this.emitCtx.Metadata.AddNestedType(nestedHandle, closureHandle); }
else if (this.methodBodyPlanner.TryGetUserKickoffReceiverHandle(s, out var receiverEnclosing)) { this.emitCtx.Metadata.AddNestedType(nestedHandle, receiverEnclosing); }
else { var smPkg = this.methodBodyPlanner.GetSmPackage(s, packages, entryPointPackage); var enclosingHandle = programTypeDefHandles.TryGetValue(smPkg, out var ph) ? ph : defaultProgramHandle;
this.emitCtx.Metadata.AddNestedType(nestedHandle, enclosingHandle); } } var assemblyName = this.emitCtx.AssemblyNameOverride ?? this.emitCtx.Program.PackageName ?? "Default";
var mvidFixup = this.emitCtx.Metadata.ReserveGuid(); this.emitCtx.Metadata.AddModule( generation: 0, moduleName: this.emitCtx.Metadata.GetOrAddString(assemblyName + ".dll"),
mvid: mvidFixup.Handle, encId: default(GuidHandle), encBaseId: default(GuidHandle)); var assemblyHandle = this.emitCtx.Metadata.AddAssembly(
name: this.emitCtx.Metadata.GetOrAddString(assemblyName), version: this.ParseAssemblyVersion(), culture: default(StringHandle), publicKey: default(BlobHandle),
flags: 0, hashAlgorithm: AssemblyHashAlgorithm.Sha1); if (this.emitCtx.MetadataOnly) {
this.EmitReferenceAssemblyAttribute(assemblyHandle); } this.EmitAssemblyInteropAttributes(assemblyHandle); if (!this.emitCtx.MetadataOnly && this.emitCtx.Pdb != null)
{ this.EmitDebuggableAttribute(assemblyHandle); } BlobBuilder pdbBlob = null;
BlobContentId pdbContentId = default; byte[] pdbChecksum = null; var pdbEnabled = this.emitCtx.Pdb != null; if (pdbEnabled)
{ var peRowCounts = this.emitCtx.Metadata.GetRowCounts(); (pdbBlob, pdbContentId) = this.emitCtx.Pdb.Serialize( peRowCounts,
this.emitCtx.MetadataOnly ? default : entryHandle, ComputeDeterministicContentId); pdbChecksum = ComputePdbChecksum(pdbBlob); }
DebugDirectoryBuilder debugDirectory = null; var isEmbedded = this.emitCtx.DebugInformation.Format == DebugInformationFormat.Embedded; if (pdbEnabled) {
debugDirectory = new DebugDirectoryBuilder(); string codeViewPath; if (!string.IsNullOrEmpty(this.emitCtx.DebugInformation.PdbFilePath)) {
codeViewPath = isEmbedded ? Path.GetFileName(this.emitCtx.DebugInformation.PdbFilePath) : Path.GetFullPath(this.emitCtx.DebugInformation.PdbFilePath); }
else { codeViewPath = (this.emitCtx.AssemblyNameOverride ?? this.emitCtx.Program.PackageName ?? "module") + ".pdb"; }
debugDirectory.AddCodeViewEntry( pdbPath: codeViewPath, pdbContentId: pdbContentId, portablePdbVersion: PortablePdbVersion);
debugDirectory.AddPdbChecksumEntry( algorithmName: "SHA256", checksum: ImmutableArray.Create(pdbChecksum)); if (this.emitCtx.DebugInformation.Deterministic)
{ debugDirectory.AddReproducibleEntry(); } if (isEmbedded)
{ debugDirectory.AddEmbeddedPortablePdbEntry(pdbBlob, PortablePdbVersion); } }
TypeDefEmitter.FlushPendingGenericParameters(this.emitCtx, this.GetElementTypeToken); var peHeaderBuilder = new PEHeaderBuilder( imageCharacteristics: entryHandle.IsNil ? Characteristics.Dll | Characteristics.ExecutableImage
: Characteristics.ExecutableImage); var peBlob = new BlobBuilder(); BlobContentId contentId; if (this.emitCtx.MetadataOnly)
{ var mvidBuilder = new MvidPEBuilder( header: peHeaderBuilder, metadataRootBuilder: new MetadataRootBuilder(this.emitCtx.Metadata),
ilStream: this.emitCtx.IlStream, entryPoint: default, debugDirectoryBuilder: debugDirectory, deterministicIdProvider: ComputeDeterministicContentId);
contentId = mvidBuilder.Serialize(peBlob, out var mvidSectionFixup); new BlobWriter(mvidSectionFixup).WriteGuid(contentId.Guid); } else
{ var peBuilder = new ManagedPEBuilder( header: peHeaderBuilder, metadataRootBuilder: new MetadataRootBuilder(this.emitCtx.Metadata),
ilStream: this.emitCtx.IlStream, entryPoint: entryHandle, debugDirectoryBuilder: debugDirectory, deterministicIdProvider: ComputeDeterministicContentId);
contentId = peBuilder.Serialize(peBlob); } mvidFixup.CreateWriter().WriteGuid(contentId.Guid); peBlob.WriteContentTo(peStream);
if (pdbEnabled && !isEmbedded && this.emitCtx.PdbStream != null) { pdbBlob.WriteContentTo(this.emitCtx.PdbStream); }
}


    /// <summary>
    /// Marks the assembly with
    /// <c>System.Runtime.CompilerServices.ReferenceAssemblyAttribute()</c> so
    /// loaders treat it as metadata-only and refuse to execute its (absent)
    /// method bodies.
    /// </summary>
    private void EmitReferenceAssemblyAttribute(AssemblyDefinitionHandle assemblyHandle)
    {
        var attrType = this.emitCtx.References.TryResolveType("System.Runtime.CompilerServices.ReferenceAssemblyAttribute", out var resolved)
            ? resolved
            : throw new InvalidOperationException(
                "Reference assembly emit requires System.Runtime.CompilerServices.ReferenceAssemblyAttribute to be resolvable from the supplied references.");
        var attrTypeRef = this.GetTypeReference(attrType);

        var ctorSig = new BlobBuilder();
        new BlobEncoder(ctorSig).MethodSignature(isInstanceMethod: true)
            .Parameters(0, r => r.Void(), _ => { });

        var ctorRef = this.emitCtx.Metadata.AddMemberReference(
            attrTypeRef,
            this.emitCtx.Metadata.GetOrAddString(".ctor"),
            this.emitCtx.Metadata.GetOrAddBlob(ctorSig));

        // Empty fixed/named argument blob: prolog 0x0001 + 0 named args.
        var valueBlob = new BlobBuilder();
        valueBlob.WriteUInt16(0x0001);
        valueBlob.WriteUInt16(0);

        this.emitCtx.Metadata.AddCustomAttribute(
            parent: assemblyHandle,
            constructor: ctorRef,
            value: this.emitCtx.Metadata.GetOrAddBlob(valueBlob));
    }

    private AssemblyReferenceHandle GetAssemblyReference(Assembly assembly)
    {
        if (this.cache.AssemblyRefs.TryGetValue(assembly, out var existing))
        {
            return existing;
        }

        var name = assembly.GetName();
        var publicKeyToken = name.GetPublicKeyToken();
        var publicKeyOrTokenBlob = publicKeyToken is { Length: > 0 }
            ? this.emitCtx.Metadata.GetOrAddBlob(publicKeyToken)
            : default(BlobHandle);
        var handle = this.emitCtx.Metadata.AddAssemblyReference(
            name: this.emitCtx.Metadata.GetOrAddString(name.Name ?? string.Empty),
            version: name.Version ?? new Version(0, 0, 0, 0),
            culture: default(StringHandle),
            publicKeyOrToken: publicKeyOrTokenBlob,
            flags: default(AssemblyFlags),
            hashValue: default(BlobHandle));
        this.cache.AssemblyRefs[assembly] = handle;
        return handle;
    }

    /// <summary>
    /// Issue #242: Returns an AssemblyReferenceHandle for <c>System.Runtime</c>,
    /// the public facade assembly that external consumers (C#/F# projects)
    /// reference. Used as the resolution scope for base-type TypeRefs
    /// (System.Object, System.ValueType, System.Enum) so that compiled
    /// libraries are consumable without requiring a direct reference to
    /// <c>System.Private.CoreLib</c>.
    /// </summary>
    private AssemblyReferenceHandle GetSystemRuntimeAssemblyReference()
    {
        if (!this.cache.SystemRuntimeAssemblyRef.IsNil)
        {
            return this.cache.SystemRuntimeAssemblyRef;
        }

        AssemblyName sysRuntimeName;
        try
        {
            sysRuntimeName = Assembly.Load("System.Runtime").GetName();
        }
        catch
        {
            // Fallback: construct the identity using the well-known .NET
            // public key token (b03f5f7f11d50a3a) and the host CoreLib version.
            sysRuntimeName = new AssemblyName("System.Runtime")
            {
                Version = typeof(object).Assembly.GetName().Version ?? new Version(0, 0, 0, 0),
            };
            sysRuntimeName.SetPublicKeyToken(new byte[] { 0xb0, 0x3f, 0x5f, 0x7f, 0x11, 0xd5, 0x0a, 0x3a });
        }

        var publicKeyToken = sysRuntimeName.GetPublicKeyToken();
        var publicKeyOrTokenBlob = publicKeyToken is { Length: > 0 }
            ? this.emitCtx.Metadata.GetOrAddBlob(publicKeyToken)
            : default(BlobHandle);
        this.cache.SystemRuntimeAssemblyRef = this.emitCtx.Metadata.AddAssemblyReference(
            name: this.emitCtx.Metadata.GetOrAddString(sysRuntimeName.Name ?? "System.Runtime"),
            version: sysRuntimeName.Version ?? new Version(0, 0, 0, 0),
            culture: default(StringHandle),
            publicKeyOrToken: publicKeyOrTokenBlob,
            flags: default(AssemblyFlags),
            hashValue: default(BlobHandle));
        return this.cache.SystemRuntimeAssemblyRef;
    }

    // ADR-0118 / issue #944: indexer get_Item/set_Item accessors are reached
    // through BoundUserInstanceCallExpression (obj[i] / obj[i]=v), whose emit
    // resolves the accessor via cache.MethodHandles. Mirror the planned
    // PropertyAccessorHandles rows into MethodHandles for indexer accessors.
    // Issue #1104: a base-property access (`base.Prop` / `base.Prop = v`) is
    // lowered to a BoundBaseClassCallExpression over the property's getter /
    // setter FunctionSymbol, which the emitter also resolves via
    // cache.MethodHandles — so register ordinary instance property accessors
    // there too (not just indexers).
    private void RegisterIndexerAccessorHandles(
        PropertySymbol prop,
        MethodDefinitionHandle? getterHandle,
        MethodDefinitionHandle? setterHandle)
    {
        if (prop.GetterSymbol != null && getterHandle.HasValue)
        {
            this.cache.MethodHandles[prop.GetterSymbol] = getterHandle.Value;
        }

        if (prop.SetterSymbol != null && setterHandle.HasValue)
        {
            this.cache.MethodHandles[prop.SetterSymbol] = setterHandle.Value;
        }
    }

    /// <summary>
    /// Issue #490 (ADR-0060 follow-up): a function whose <see cref="FunctionSymbol.ReturnRefKind"/>
    /// is <see cref="RefKind.Ref"/> returns a managed pointer (<c>T&amp;</c>) — encode it via
    /// the <c>ReturnTypeEncoder.Type(isByRef: true, ...)</c> overload.
    /// </summary>
    private void EncodeReturnSymbol(ReturnTypeEncoder encoder, TypeSymbol type, RefKind returnRefKind)
    {
        if (type == TypeSymbol.Void)
        {
            encoder.Void();
        }
        else
        {
            this.EncodeTypeSymbol(encoder.Type(isByRef: returnRefKind == RefKind.Ref), type);
        }
    }

    private void EncodeReturnClr(ReturnTypeEncoder encoder, ParameterInfo returnParameter, Type type)
    {
        if (type?.FullName == "System.Void")
        {
            // Issue #522: a void return may still carry required custom
            // modifiers — most notably C# 9 init-only property setters emit
            // `modreq(System.Runtime.CompilerServices.IsExternalInit)` on the
            // setter's void return. The modreq is part of the method
            // signature; if we omit it the MemberRef fails to resolve at
            // runtime (System.MissingMethodException). Mirrors the byref
            // branch below — encode modreqs first, then the void slot.
            var voidRequiredModifiers = returnParameter?.GetRequiredCustomModifiers() ?? Type.EmptyTypes;
            if (voidRequiredModifiers.Length > 0)
            {
                var modifiers = encoder.CustomModifiers();
                foreach (var modifier in voidRequiredModifiers)
                {
                    modifiers.AddModifier(this.GetTypeReference(modifier), isOptional: false);
                }
            }

            encoder.Void();
        }
        else if (type != null && type.IsByRef)
        {
            // ADR-0056 §1/§2: a `ref`/`ref readonly T` return (e.g. the span
            // indexer's `get_Item`) must encode as a managed pointer to the
            // pointee. A `ref readonly T` return additionally carries a required
            // custom modifier (`modreq(InAttribute)` on `ReadOnlySpan[T]`); it
            // must be encoded or the methodref signature fails to resolve at
            // runtime (MissingMethodException). Without `isByRef: true` the
            // return was malformed for every ref-returning member.
            var requiredModifiers = returnParameter?.GetRequiredCustomModifiers() ?? Type.EmptyTypes;
            if (requiredModifiers.Length > 0)
            {
                var modifiers = encoder.CustomModifiers();
                foreach (var modifier in requiredModifiers)
                {
                    modifiers.AddModifier(this.GetTypeReference(modifier), isOptional: false);
                }
            }

            this.EncodeClrType(encoder.Type(isByRef: true), type.GetElementType()!);
        }
        else
        {
            this.EncodeClrType(encoder.Type(), type);
        }
    }

    private static bool StaticVirtualSignatureEquals(FunctionSymbol a, FunctionSymbol b)
    {
        if (a == null || b == null)
        {
            return false;
        }

        if (a.Parameters.Length != b.Parameters.Length)
        {
            return false;
        }

        if (!ReferenceEquals(a.Type, b.Type) && a.Type?.Name != b.Type?.Name)
        {
            return false;
        }

        for (var i = 0; i < a.Parameters.Length; i++)
        {
            var pa = a.Parameters[i].Type;
            var pb = b.Parameters[i].Type;
            if (!ReferenceEquals(pa, pb) && pa?.Name != pb?.Name)
            {
                return false;
            }
        }

        return true;
    }
}
