// <copyright file="GeneratedDocTranslator.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.GeneratorHost

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Text
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.Globalization
import System.Linq

/// ADR-0145 §C: back-translates each generator-produced C# document into a
/// standalone G# `partial` part.
///
/// The generated C# is bound in a single (cref:CSharpCompilation) that
/// also contains the stub tree, so a generated member's references to
/// user-declared types (and to package runtime types) resolve. Each generated
/// tree is then translated with
/// (cref:CSharpToGSharpTranslator)(`preservePartialParts: true`) so
/// a generated `partial class Foo` becomes a standalone G# `partial`
/// part that augments the user's own type rather than being merged.
shared class GeneratedDocTranslator {
    /// The path of the stub tree in the back-translation compilation. The
    /// translator tells the stub from generator output by path (a generated
    /// implementation whose definition is NOT in a translated file becomes a
    /// G# implementing part), so this path must be one no generator can emit:
    /// Roslyn rejects a hint name containing `<` or `>`
    /// (`AddSource` throws), so no generated tree can share it.
    const StubPath string = "<gsgen-stub>.cs"

    /// The gsgen diagnostic id for a positional list stated on both a user and a generated part.
    const PositionalListConflictId string = "GS9209"

    /// Back-translates the generated C# documents into G# partial parts.
    /// @param stubCSharp The declaration-only C# stub the generators ran against.
    /// @param generated The generated C# documents.
    /// @param references The metadata references used to bind stub + generated code.
    /// @param declaringParts The lone G# declaring parts the stub rendered as C# partial method
    /// definitions, whose headers the generated implementing parts are spelled
    /// with ((cref:ImplementingPartHeaders)); `null` or
    /// empty to keep every header as back-translated.
    /// @param dataTypes The top-level G# data types the stub rendered, whose generated parts
    /// are spelled as `data` parts ((cref:SpellDataTypeParts));
    /// `null` or empty for none.
    /// @param inputStubTree The immutable generator input tree, or none for standalone translation.
    /// @param semanticOnlyAbstractTypes The types the stub rendered `abstract` only because they inherit
    /// unimplemented abstract members, keyed by `SemanticAbstractTypeKey` and mapped to
    /// whether the user declared them `open` (issues #5252/#5253). The generated parts of
    /// these types state neither `abstract` nor `open`, whatever the generator
    /// mirrored from the stub; `null` or empty for none.
    /// @returns The back-translated G# parts: one per namespace of each generated document with members or
    /// file-level attributes.
    func Translate(
        stubCSharp string,
        generated IReadOnlyList[GeneratedCsDocument],
        references IReadOnlyList[MetadataReference],
        declaringParts IReadOnlyList[StubPartialDefinition]? = nil,
        dataTypes IReadOnlyList[StubDataType]? = nil,
        inputStubTree SyntaxTree? = nil,
        semanticOnlyAbstractTypes IReadOnlyDictionary[string, bool]? = nil
    ) IReadOnlyList[TranslatedGsDocument] {
        using let phase = CompilationMeasurements.BeginPhase("generator.translation")
        ArgumentNullException.ThrowIfNull(stubCSharp, paramName: "stubCSharp")
        ArgumentNullException.ThrowIfNull(generated, paramName: "generated")
        ArgumentNullException.ThrowIfNull(references, paramName: "references")
        let results = List[TranslatedGsDocument]()
        if generated.Count == 0 {
            return results
        }
        let parseOptions = CSharpParseOptions(LanguageVersion.Latest)
        let stubTree = if inputStubTree != nil {
            CompilationMeasurements.Count("generator.stub_tree_reuses")
            inputStubTree.WithFilePath(StubPath)
        } else {
            CompilationMeasurements.Count("generator.host_csharp_trees_parsed")
            CSharpSyntaxTree.ParseText(stubCSharp, parseOptions, path: StubPath)
        }
        // Bind stub + every generated tree together so generated members resolve
        // against user declarations and package runtime types.
        let generatedTrees = List[(Doc GeneratedCsDocument, Tree SyntaxTree)]()
        for doc in generated {
            let tree = if doc.SyntaxTree is {} generatedTree {
                CompilationMeasurements.Count("generator.generated_tree_reuses")
                generatedTree.WithFilePath(doc.HintName)
            } else {
                CompilationMeasurements.Count("generator.host_csharp_trees_parsed")
                CSharpSyntaxTree.ParseText(doc.SourceText, parseOptions, path: doc.HintName)
            }
            generatedTrees.Add((doc, tree))
        }
        let trees = List[SyntaxTree]{stubTree}
        trees.AddRange(generatedTrees.Select((t(Doc GeneratedCsDocument, Tree SyntaxTree)) -> t.Tree))
        let compilation = CSharpCompilation.Create(
            "GsgenBackTranslate",
            trees,
            references,
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary).WithNullableContextOptions(
                NullableContextOptions.Enable
            )
                .WithAllowUnsafe(true)
        )
        // Every generated tree is translated; the stub never is. A generated
        // partial method implementation whose definition is in the stub (a
        // user G# declaring part, e.g. `@GeneratedRegex ... partial func`)
        // therefore becomes a G# implementing part (ADR-0192 follow-on 2).
        let translatedFilePaths = generatedTrees.Select(
            (t(Doc GeneratedCsDocument, Tree SyntaxTree)) -> t.Tree.FilePath
        )
            .ToList()
        // The output-file stems the generator's own hint names occupy: a split
        // unit's name never takes one, so which file keeps a plain name does
        // not depend on write order.
        let usedStems = HashSet[string](
            generated.Select((doc GeneratedCsDocument) -> OutputStem(doc.HintName)),
            StringComparer.OrdinalIgnoreCase
        )
        for (doc, tree) in generatedTrees {
            let model = compilation.GetSemanticModel(tree)
            let loaded = LoadedDocument(doc.HintName, tree, model)
            // ADR-0192 follow-on 2, step 4: one G# unit per C# namespace the
            // document declares, exactly as `cs2gs migrate`'s repository
            // layout splits a multi-namespace file (TranslateStage). A single
            // unit would hoist every declaration into the first namespace: the
            // Regex generator's one file declares the user's `partial class P`
            // in the user's namespace AND its helper types (`Digits_0`,
            // `Utilities`, `RunnerFactory`, the `IndexOfAny*` extension funcs)
            // in `System.Text.RegularExpressions.Generated`, so collapsing the
            // two put the helpers in the user's package, where a user type
            // named `Utilities` collided with them (GS0102). Split, the helpers
            // keep their own package and the user-package unit reaches them
            // through an ordinary import. The generator declares those helpers
            // `file` classes; G# has no file scope, so they surface as
            // `internal` types of that distinct package: invisible outside the
            // assembly, and out of the user's package namespace. Several user
            // packages that each use the generator still get ONE helper
            // package, because the generator emits one file with one
            // `Generated` namespace.
            let packages IReadOnlyList[string] = CSharpToGSharpTranslator
                .GetDeclaredPackages(loaded)
                .OrderBy(($package string) -> $package.Count((c char) -> c == '.'))
                .ToList()
            let unitCount = Math.Max(1, packages.Count)
            for var unitIndex = 0; unitIndex < unitCount; unitIndex++ {
                let package_ string? = if packages.Count > 1 {
                    packages[unitIndex]
                } else {
                    default(string?)
                }
                var unit = CSharpToGSharpTranslator(
                    preservePartialParts: true,
                    packageFilter: package_,
                    includeFileAttributes: unitIndex == 0,
                    includeGlobalNamespace: unitIndex == 0,
                    widenObliviousReferenceFields: true,
                    translatedFilePaths: translatedFilePaths,
                    emitGeneratedImplementingParts: true,
                    semanticOnlyAbstractTypes: semanticOnlyAbstractTypes
                ).TranslateDocument(loaded)
                let hostDiagnostics = List[GeneratorHostDiagnostic]()
                unit = SpellDataTypeParts(unit, dataTypes ?? Array.Empty[StubDataType](), hostDiagnostics)
                // Skip a unit that carried no translatable content.
                if unit.Members.Count == 0 && unit.FileAttributes.Count == 0 {
                    continue
                }
                let gs = ImplementingPartHeaders.Apply(
                    unit,
                    GSharpPrinter.Print(unit),
                    declaringParts ?? Array.Empty[StubPartialDefinition](),
                    hostDiagnostics
                )
                let roundTrip = GSharpRoundTrip.Validate(gs)
                let hintName = if unitIndex == 0 {
                    doc.HintName
                } else {
                    SplitHintName(doc.HintName, package_, usedStems)
                }
                results.Add(TranslatedGsDocument(hintName, gs, roundTrip.Errors, hostDiagnostics))
            }
        }
        return results
    }

    /// ADR-0192 amendment (partial data types): spells each top-level part of
    /// a user G# data type as a `partial data class` / `partial data
    /// struct` part with no `open` and no `sealed`. gsc requires
    /// `data` on every part of a data type (GS0479), but the generated C#
    /// re-declares the type with whatever keyword the stub gave it: a
    /// `class` for a data type the stub cannot render as a record (see
    /// `GsStubRenderer.PlanRecords`), and a record's synthesized virtual
    /// members make the translator spell a non-sealed record `open`,
    /// which contradicts a user part that says `sealed` (GS0478).
    /// Openness and sealedness are the user's to state (gsc unions them across
    /// parts, ADR-0144 §C), so a generated part states neither.
    /// An explicitly generator-authored abstract modifier is preserved, except on a
    /// type the stub made abstract only semantically (issue #5252), whose parts the
    /// translator already printed without it.
    ///
    /// A positional parameter list a generator supplies is kept when no user
    /// part states one. Only one part may (GS0482), so when both do, the
    /// generated list is not silently dropped: it is reported as
    /// `GS9209` at the user's list, and the part keeps it, so gsc
    /// reports the conflict too.
    private func SpellDataTypeParts(
        unit CompilationUnit,
        dataTypes IReadOnlyList[StubDataType],
        diagnostics List[GeneratorHostDiagnostic]
    ) CompilationUnit {
        if dataTypes.Count == 0 {
            return unit
        }
        let members = List[GNode](unit.Members.Count)
        var changed = false
        for member in unit.Members {
            let dataType StubDataType? = if member is TypeDeclaration{IsPartial: true} type {
                dataTypes.FirstOrDefault(
                    (candidate StubDataType) -> string.Equals(
                        candidate.PackageName ?? string.Empty,
                        unit.Package ?? string.Empty,
                        StringComparison.Ordinal
                    ) &&
                        string.Equals(candidate.TypeName, type.Name, StringComparison.Ordinal) &&
                        candidate.TypeArity == type.TypeParameters!!.Count
                )
            } else {
                default(StubDataType?)
            }
            if dataType == nil {
                members.Add(member)
                continue
            }
            let part = cast[TypeDeclaration](member)
            if part.PrimaryConstructorParameters != nil && dataType.PositionalList is TextLocation userList {
                let message = "a generator declared a positional parameter list on '${part.Name}', which already has one; " +
                    "only one part of a data type may state it"
                diagnostics.Add(GeneratorHostDiagnostic(PositionalListConflictId, message, userList))
            }
            members.Add(
                TypeDeclaration(
                    if dataType.IsClass {
                        TypeDeclarationKind.DataClass
                    } else {
                        TypeDeclarationKind.DataStruct
                    },
                    part.Name,
                    part.TypeParameters,
                    part.PrimaryConstructorParameters,
                    part.BaseType,
                    part.BaseConstructorArguments,
                    part.Interfaces,
                    part.Members,
                    part.Visibility,
                    isOpen: false,
                    isSealed: false,
                    isAbstract: part.IsAbstract,
                    isPartial: true,
                    part.HasBody,
                    part.Attributes,
                    part.IsUnsafe,
                    part.IsRefLike
                )
            )
            changed = true
        }
        return if changed {
            CompilationUnit(unit.Package, unit.Imports, members, unit.LeadingComments, unit.FileAttributes)
        } else {
            unit
        }
    }

    /// The hint name of a secondary namespace unit split out of a generated
    /// document: the document's own hint name with the package, dots turned
    /// into underscores, before its extension (`RegexGenerator.g.cs` in
    /// `System.Text.RegularExpressions.Generated` becomes
    /// `RegexGenerator.System_Text_RegularExpressions_Generated.g.cs`),
    /// so every unit is written to its own deterministic `.g.gs` file.
    /// A name whose output file a generator hint name (or an earlier split
    /// unit) already takes gets a `.split`, `.split2`, ... marker.
    private func SplitHintName(hintName string, $package string?, usedStems HashSet[string]) string {
        let stem = StripExtension(hintName) + "." + $package!!.Replace('.', '_')
        var candidate = stem
        for var attempt = 1; !usedStems.Add(OutputStem(candidate)); attempt++ {
            candidate = stem +
                ".split" +
                (
                if attempt == 1 {
                    string.Empty
                } else {
                    attempt.ToString(CultureInfo.InvariantCulture)
                }
            )
        }
        return candidate + ".g.cs"
    }

    // The part of a hint name gsgen's writer keeps before appending `.g.gs`
    // (GsgenProgram.ToOutputFileName): separators flattened, the generator
    // extension dropped.
    private func OutputStem(hintName string) string -> StripExtension(hintName.Replace('\\', '_').Replace('/', '_'))

    private func StripExtension(hintName string) string {
        for extension in[]string{".g.gs", ".g.cs", ".gs", ".cs"} {
            if hintName.EndsWith(extension, StringComparison.OrdinalIgnoreCase) {
                return hintName.Substring(0, hintName.Length - extension.Length)
            }
        }
        return hintName
    }
}

/// One back-translated G# part: its originating hint name, the G# source, and
/// any G# round-trip parse errors recorded while validating it (ADR-0145 §C).
class TranslatedGsDocument {
    /// Initializes a new instance of the (cref:TranslatedGsDocument) class.
    /// @param hintName The originating generator hint name.
    /// @param gSharpSource The back-translated G# source.
    /// @param roundTripErrors Round-trip parse errors, empty when the G# is valid.
    /// @param hostDiagnostics Diagnostics the host reported while producing the part, or `null` for none.
    init(
        hintName string,
        gSharpSource string,
        roundTripErrors IReadOnlyList[string],
        hostDiagnostics IReadOnlyList[GeneratorHostDiagnostic]? = nil
    ) {
        HintName = hintName
        GSharpSource = gSharpSource
        RoundTripErrors = roundTripErrors ?? Array.Empty[string]()
        HostDiagnostics = hostDiagnostics ?? Array.Empty[GeneratorHostDiagnostic]()
    }

    /// Gets the originating generator hint name.
    prop HintName string {
        get;
    }

    /// Gets the back-translated G# source.
    prop GSharpSource string {
        get;
    }

    /// Gets the G# round-trip parse errors (empty when valid).
    prop RoundTripErrors IReadOnlyList[string] {
        get;
    }

    /// Gets the diagnostics the host reported while producing the part (e.g. `GS9208`).
    prop HostDiagnostics IReadOnlyList[GeneratorHostDiagnostic] {
        get;
    }
}
