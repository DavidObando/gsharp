// <copyright file="GsharpCompilation.Abstracts.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#if GSHARP_ROSLYN_FORK_AVAILABLE

#nullable enable
#pragma warning disable SA1008 // Opening parenthesis should not be preceded/followed by a space
#pragma warning disable SA1124 // Do not use regions
#pragma warning disable SA1201 // Elements should appear in the correct order
#pragma warning disable SA1202 // Elements should be ordered by access
#pragma warning disable SA1210 // Using directives should be ordered alphabetically by namespace
#pragma warning disable SA1316 // Tuple element names should use correct casing
#pragma warning disable SA1516 // Elements should be separated by blank line
#pragma warning disable SA1600 // Elements should be documented
#pragma warning disable SA1601 // Partial elements should be documented
#pragma warning disable CA1065 // Properties should not throw exceptions
#pragma warning disable RSEXPERIMENTAL001 // Roslyn experimental APIs
#pragma warning disable CS1591 // Missing XML comment for publicly visible type or member

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Globalization;
using System.IO;
using System.Reflection.Metadata;
using System.Threading;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CodeGen;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.Emit;
using Microsoft.CodeAnalysis.Operations;
using Microsoft.CodeAnalysis.Symbols;

namespace Gsharp.CodeAnalysis.Compilation;

/// <summary>
/// Auto-generated stub overrides for <see cref="Microsoft.CodeAnalysis.Compilation"/>
/// abstract members. These all throw <see cref="NotImplementedException"/> for now;
/// Phase 1+ replaces stubs with real implementations as needed by the GSharp emit
/// pipeline. Regenerate via <c>tools/gen-compilation-stubs.py</c> against the
/// pinned Roslyn fork commit if rebasing.
/// </summary>
public sealed partial class GsharpCompilation
{
    internal override AnalyzerDriver CreateAnalyzerDriver(ImmutableArray<DiagnosticAnalyzer> analyzers, AnalyzerManager analyzerManager, SeverityFilter severityFilter) => throw new System.NotImplementedException();
    internal override void SerializePdbEmbeddedCompilationOptions(BlobBuilder builder) => throw new System.NotImplementedException();
    protected override Microsoft.CodeAnalysis.Compilation CommonClone() => throw new System.NotImplementedException();
    internal override Microsoft.CodeAnalysis.Compilation WithEventQueue(AsyncQueue<CompilationEvent>? eventQueue) => throw new System.NotImplementedException();
    internal override Microsoft.CodeAnalysis.Compilation WithSemanticModelProvider(SemanticModelProvider semanticModelProvider) => throw new System.NotImplementedException();
    protected override SemanticModel CommonGetSemanticModel(SyntaxTree syntaxTree, SemanticModelOptions options) => throw new System.NotImplementedException();
    internal override SemanticModel CreateSemanticModel(SyntaxTree syntaxTree, SemanticModelOptions options) => throw new System.NotImplementedException();
    protected override INamedTypeSymbol CommonCreateErrorTypeSymbol(INamespaceOrTypeSymbol? container, string name, int arity) => throw new System.NotImplementedException();
    protected override INamespaceSymbol CommonCreateErrorNamespaceSymbol(INamespaceSymbol container, string name) => throw new System.NotImplementedException();
    protected override IPreprocessingSymbol CommonCreatePreprocessingSymbol(string name) => throw new System.NotImplementedException();
    protected override Microsoft.CodeAnalysis.Compilation CommonWithAssemblyName(string? outputName) => throw new System.NotImplementedException();
    protected override Microsoft.CodeAnalysis.Compilation CommonWithOptions(CompilationOptions options) => throw new System.NotImplementedException();
    internal override bool HasSubmissionResult() => throw new System.NotImplementedException();
    protected override Microsoft.CodeAnalysis.Compilation CommonWithScriptCompilationInfo(ScriptCompilationInfo? info) => throw new System.NotImplementedException();
    protected override Microsoft.CodeAnalysis.Compilation CommonAddSyntaxTrees(IEnumerable<SyntaxTree> trees) => throw new System.NotImplementedException();
    protected override Microsoft.CodeAnalysis.Compilation CommonRemoveSyntaxTrees(IEnumerable<SyntaxTree> trees) => throw new System.NotImplementedException();
    protected override Microsoft.CodeAnalysis.Compilation CommonRemoveAllSyntaxTrees() => throw new System.NotImplementedException();
    protected override Microsoft.CodeAnalysis.Compilation CommonReplaceSyntaxTree(SyntaxTree oldTree, SyntaxTree newTree) => throw new System.NotImplementedException();
    protected override bool CommonContainsSyntaxTree(SyntaxTree? syntaxTree) => throw new System.NotImplementedException();
    internal override CommonReferenceManager CommonGetBoundReferenceManager() => throw new System.NotImplementedException();
    public override CompilationReference ToMetadataReference(ImmutableArray<string> aliases = default(ImmutableArray<string>), bool embedInteropTypes = false) => throw new System.NotImplementedException();
    protected override Microsoft.CodeAnalysis.Compilation CommonWithReferences(IEnumerable<MetadataReference> newReferences) => throw new System.NotImplementedException();
    protected override ISymbol? CommonGetAssemblyOrModuleSymbol(MetadataReference reference) => throw new System.NotImplementedException();
    internal override TSymbol GetSymbolInternal<TSymbol>(ISymbol? symbol)
        where TSymbol : class => throw new System.NotImplementedException();
    private protected override MetadataReference? CommonGetMetadataReference(IAssemblySymbol assemblySymbol) => throw new System.NotImplementedException();
    protected override INamespaceSymbol? CommonGetCompilationNamespace(INamespaceSymbol namespaceSymbol) => throw new System.NotImplementedException();
    protected override IMethodSymbol? CommonGetEntryPoint(CancellationToken cancellationToken) => throw new System.NotImplementedException();
    internal override ISymbolInternal CommonGetSpecialTypeMember(SpecialMember specialMember) => throw new System.NotImplementedException();
    internal override bool IsSystemTypeReference(ITypeSymbolInternal type) => throw new System.NotImplementedException();
    private protected override INamedTypeSymbolInternal CommonGetSpecialType(SpecialType specialType) => throw new System.NotImplementedException();
    internal override ISymbolInternal? CommonGetWellKnownTypeMember(WellKnownMember member) => throw new System.NotImplementedException();
    internal override ITypeSymbolInternal CommonGetWellKnownType(WellKnownType wellknownType) => throw new System.NotImplementedException();
    internal override bool IsAttributeType(ITypeSymbol type) => throw new System.NotImplementedException();
    protected override IArrayTypeSymbol CommonCreateArrayTypeSymbol(ITypeSymbol elementType, int rank, NullableAnnotation elementNullableAnnotation) => throw new System.NotImplementedException();
    protected override IPointerTypeSymbol CommonCreatePointerTypeSymbol(ITypeSymbol elementType) => throw new System.NotImplementedException();
    protected override IFunctionPointerTypeSymbol CommonCreateFunctionPointerTypeSymbol( ITypeSymbol returnType, RefKind returnRefKind, ImmutableArray<ITypeSymbol> parameterTypes, ImmutableArray<RefKind> parameterRefKinds, SignatureCallingConvention callingConvention, ImmutableArray<INamedTypeSymbol> callingConventionTypes) => throw new System.NotImplementedException();
    protected override INamedTypeSymbol CommonCreateNativeIntegerTypeSymbol(bool signed) => throw new System.NotImplementedException();
    protected override INamedTypeSymbol? CommonGetTypeByMetadataName(string metadataName) => throw new System.NotImplementedException();
    protected override INamedTypeSymbol CommonCreateTupleTypeSymbol( ImmutableArray<ITypeSymbol> elementTypes, ImmutableArray<string?> elementNames, ImmutableArray<Location?> elementLocations, ImmutableArray<NullableAnnotation> elementNullableAnnotations) => throw new System.NotImplementedException();
    protected override INamedTypeSymbol CommonCreateTupleTypeSymbol( INamedTypeSymbol underlyingType, ImmutableArray<string?> elementNames, ImmutableArray<Location?> elementLocations, ImmutableArray<NullableAnnotation> elementNullableAnnotations) => throw new System.NotImplementedException();
    protected override INamedTypeSymbol CommonCreateAnonymousTypeSymbol( ImmutableArray<ITypeSymbol> memberTypes, ImmutableArray<string> memberNames, ImmutableArray<Location> memberLocations, ImmutableArray<bool> memberIsReadOnly, ImmutableArray<NullableAnnotation> memberNullableAnnotations) => throw new System.NotImplementedException();
    protected override IMethodSymbol CommonCreateBuiltinOperator(string name, ITypeSymbol returnType, ITypeSymbol leftType, ITypeSymbol rightType) => throw new System.NotImplementedException();
    protected override IMethodSymbol CommonCreateBuiltinOperator(string name, ITypeSymbol returnType, ITypeSymbol operandType) => throw new System.NotImplementedException();
    public override CommonConversion ClassifyCommonConversion(ITypeSymbol source, ITypeSymbol destination) => throw new System.NotImplementedException();
    private protected override bool IsSymbolAccessibleWithinCore( ISymbol symbol, ISymbol within, ITypeSymbol? throughType) => throw new System.NotImplementedException();
    internal override IConvertibleConversion ClassifyConvertibleConversion(IOperation source, ITypeSymbol destination, out ConstantValue? constantValue) => throw new System.NotImplementedException();
    public override ImmutableArray<Diagnostic> GetParseDiagnostics(CancellationToken cancellationToken = default(CancellationToken)) => throw new System.NotImplementedException();
    public override ImmutableArray<Diagnostic> GetDeclarationDiagnostics(CancellationToken cancellationToken = default(CancellationToken)) => throw new System.NotImplementedException();
    public override ImmutableArray<Diagnostic> GetMethodBodyDiagnostics(CancellationToken cancellationToken = default(CancellationToken)) => throw new System.NotImplementedException();
    public override ImmutableArray<Diagnostic> GetDiagnostics(CancellationToken cancellationToken = default(CancellationToken)) => throw new System.NotImplementedException();
    internal override void GetDiagnostics(CompilationStage stage, bool includeEarlierStages, DiagnosticBag diagnostics, CancellationToken cancellationToken = default) => throw new System.NotImplementedException();
    public override ImmutableArray<MetadataReference> GetUsedAssemblyReferences(CancellationToken cancellationToken = default(CancellationToken)) => throw new System.NotImplementedException();
    protected override void AppendDefaultVersionResource(Stream resourceStream) => throw new System.NotImplementedException();
    internal override bool HasCodeToEmit() => throw new System.NotImplementedException();
    internal override CommonPEModuleBuilder? CreateModuleBuilder( EmitOptions emitOptions, IMethodSymbol? debugEntryPoint, Stream? sourceLinkStream, IEnumerable<EmbeddedText>? embeddedTexts, IEnumerable<ResourceDescription>? manifestResources, CompilationTestData? testData, DiagnosticBag diagnostics, CancellationToken cancellationToken) => throw new System.NotImplementedException();
    internal override bool CompileMethods( CommonPEModuleBuilder moduleBuilder, bool emittingPdb, DiagnosticBag diagnostics, Predicate<ISymbolInternal>? filterOpt, CancellationToken cancellationToken) => throw new System.NotImplementedException();
    internal override void AddDebugSourceDocumentsForChecksumDirectives(DebugDocumentsBuilder documentsBuilder, SyntaxTree tree, DiagnosticBag diagnostics) => throw new System.NotImplementedException();
    internal override bool GenerateResources( CommonPEModuleBuilder moduleBuilder, Stream? win32Resources, bool useRawWin32Resources, DiagnosticBag diagnostics, CancellationToken cancellationToken) => throw new System.NotImplementedException();
    internal override bool GenerateDocumentationComments( Stream? xmlDocStream, string? outputNameOverride, DiagnosticBag diagnostics, CancellationToken cancellationToken) => throw new System.NotImplementedException();
    internal override void ReportUnusedImports( DiagnosticBag diagnostics, CancellationToken cancellationToken) => throw new System.NotImplementedException();
    internal override void CompleteTrees(SyntaxTree? filterTree) => throw new System.NotImplementedException();
    internal override EmitDifferenceResult EmitDifference( EmitBaseline baseline, IEnumerable<SemanticEdit> edits, Func<ISymbol, bool> isAddedSymbol, Stream metadataStream, Stream ilStream, Stream pdbStream, CompilationTestData? testData, CancellationToken cancellationToken) => throw new System.NotImplementedException();
    internal override void ValidateDebugEntryPoint(IMethodSymbol debugEntryPoint, DiagnosticBag diagnostics) => throw new System.NotImplementedException();
    private protected override EmitBaseline MapToCompilation(CommonPEModuleBuilder moduleBeingBuilt) => throw new System.NotImplementedException();
    internal override int GetSyntaxTreeOrdinal(SyntaxTree tree) => throw new System.NotImplementedException();
    internal override int CompareSourceLocations(Location loc1, Location loc2) => throw new System.NotImplementedException();
    internal override int CompareSourceLocations(SyntaxReference loc1, SyntaxReference loc2) => throw new System.NotImplementedException();
    internal override int CompareSourceLocations(SyntaxNode loc1, SyntaxNode loc2) => throw new System.NotImplementedException();
    public override bool ContainsSymbolsWithName(Func<string, bool> predicate, SymbolFilter filter = SymbolFilter.TypeAndMember, CancellationToken cancellationToken = default(CancellationToken)) => throw new System.NotImplementedException();
    public override IEnumerable<ISymbol> GetSymbolsWithName(Func<string, bool> predicate, SymbolFilter filter = SymbolFilter.TypeAndMember, CancellationToken cancellationToken = default(CancellationToken)) => throw new System.NotImplementedException();
    public override bool ContainsSymbolsWithName(string name, SymbolFilter filter = SymbolFilter.TypeAndMember, CancellationToken cancellationToken = default(CancellationToken)) => throw new System.NotImplementedException();
    public override IEnumerable<ISymbol> GetSymbolsWithName(string name, SymbolFilter filter = SymbolFilter.TypeAndMember, CancellationToken cancellationToken = default(CancellationToken)) => throw new System.NotImplementedException();
    internal override bool IsUnreferencedAssemblyIdentityDiagnosticCode(int code) => throw new System.NotImplementedException();
    private protected override bool SupportsRuntimeCapabilityCore(RuntimeCapability capability) => throw new System.NotImplementedException();
    public override bool IsCaseSensitive { get => throw new System.NotImplementedException(); }
    internal override ScriptCompilationInfo? CommonScriptCompilationInfo { get => throw new System.NotImplementedException(); }
    public override string Language { get => throw new System.NotImplementedException(); }
    protected override CompilationOptions CommonOptions { get => throw new System.NotImplementedException(); }
    protected internal override ImmutableArray<SyntaxTree> CommonSyntaxTrees { get => throw new System.NotImplementedException(); }
    public override ImmutableArray<MetadataReference> DirectiveReferences { get => throw new System.NotImplementedException(); }
    internal override IEnumerable<ReferenceDirective> ReferenceDirectives { get => throw new System.NotImplementedException(); }
    internal override IDictionary<(string path, string content), MetadataReference> ReferenceDirectiveMap { get => throw new System.NotImplementedException(); }
    public override IEnumerable<AssemblyIdentity> ReferencedAssemblyNames { get => throw new System.NotImplementedException(); }
    protected override IAssemblySymbol CommonAssembly { get => throw new System.NotImplementedException(); }
    protected override IModuleSymbol CommonSourceModule { get => throw new System.NotImplementedException(); }
    protected override INamespaceSymbol CommonGlobalNamespace { get => throw new System.NotImplementedException(); }
    internal override CommonAnonymousTypeManager CommonAnonymousTypeManager { get => throw new System.NotImplementedException(); }
    protected override INamedTypeSymbol CommonObjectType { get => throw new System.NotImplementedException(); }
    protected override ITypeSymbol CommonDynamicType { get => throw new System.NotImplementedException(); }
    protected override ITypeSymbol? CommonScriptGlobalsType { get => throw new System.NotImplementedException(); }
    protected override INamedTypeSymbol? CommonScriptClass { get => throw new System.NotImplementedException(); }
    internal override CommonMessageProvider MessageProvider { get => throw new System.NotImplementedException(); }
    internal override byte LinkerMajorVersion { get => throw new System.NotImplementedException(); }
    internal override bool IsDelaySigned { get => throw new System.NotImplementedException(); }
    internal override StrongNameKeys StrongNameKeys { get => throw new System.NotImplementedException(); }
    internal override Guid DebugSourceDocumentLanguageId { get => throw new System.NotImplementedException(); }
}

#endif
