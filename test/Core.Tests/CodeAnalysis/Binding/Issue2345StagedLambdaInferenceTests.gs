// <copyright file="Issue2345StagedLambdaInferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.IO
import Xunit

/// Issue #2345: an imported generic method with MULTIPLE lambda arguments (e.g. EF Core's
/// `MigrationBuilder.CreateTable<TColumns>(name, columns, schema, constraints)`) failed to
/// bind when a LATER block-bodied lambda argument's delegate-target parameter type contained an open
/// generic method type parameter (e.g. `Action<CreateTableBuilder<TColumns>>`) that only
/// closes once an EARLIER lambda argument (e.g. `Func<ColumnsBuilder, TColumns>`) has been
/// bound and its output inferred.
///
/// Root cause: without a resolvable delegate target, a block-bodied lambda's implicit return type was
/// incorrectly inferred from the VALUE of its trailing statement rather than defaulting to
/// `void`. When that trailing statement was a fluent/self-returning method call (EF's
/// `Annotation(string, object)` returning `CreateTableBuilder<TColumns>`), this produced a
/// value-returning `Func<…>`-shaped lambda instead of the expected `void`-returning
/// `Action<…>`-shaped one, so the outer generic call's overload resolution reported
/// `NoneApplicable`, cascading to a misleading GS0159 "Cannot find function" diagnostic.
///
/// The fix generalizes the existing deferred/probe lambda-binding infrastructure (issue #903's symbolic
/// deferred-lambda-target recovery): a block-bodied lambda argument whose delegate target is blocked
/// solely by an open generic method type parameter is now DEFERRED (instead of eagerly bound with no
/// target) until the outer call's other arguments have contributed enough information to close the
/// method's type parameters, at which point the delegate's real (possibly `void`) return type is
/// recovered and used, restoring the correct "block body defaults to `void`" semantics. This is
/// EF-agnostic: it applies to any imported (or source) generic method, at any lambda parameter
/// position,
/// for `Action`/`Func`/`Expression<Func<…>>` shapes, with or without explicit
/// type arguments.
open class Issue2345StagedLambdaInferenceTests {
    @Fact
    func LaterBlockBodiedLambdaWithFluentTrailingCallInfersVoidAfterEarlierLambdaClosesTypeParameter() {
        let result = CompileAgainstLibrary(`package Demo
import Lib

data class Cols(Id string)

func Run(migrationBuilder MigrationBuilder) {
    migrationBuilder.CreateTable("Accounts", (table ColumnsBuilder) -> Cols{Id: table.Column("id")}, "dbo", (table CreateTableBuilder[Cols]) -> {
        table.Annotation("foo", "bar")
    })
}`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0159")
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
    }

    @Fact
    func MultipleFluentCallsInsideConstraintsLambdaBodyStillInfersVoid() {
        let result = CompileAgainstLibrary(`package Demo
import Lib

data class Cols(Id string)

func Run(migrationBuilder MigrationBuilder) {
    migrationBuilder.CreateTable("Accounts", (table ColumnsBuilder) -> Cols{Id: table.Column("id")}, "dbo", (table CreateTableBuilder[Cols]) -> {
        table.Annotation("a", "b")
        table.Annotation("c", "d")
    })
}`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0159")
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
    }

    @Fact
    func EmptyConstraintsLambdaBodyStillBinds() {
        let result = CompileAgainstLibrary(`package Demo
import Lib

data class Cols(Id string)

func Run(migrationBuilder MigrationBuilder) {
    migrationBuilder.CreateTable("Accounts", (table ColumnsBuilder) -> Cols{Id: table.Column("id")}, "dbo", (table CreateTableBuilder[Cols]) -> {
    })
}`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0159")
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
    }

    @Fact
    func ExplicitOuterTypeArgumentsStillResolve() {
        let result = CompileAgainstLibrary(`package Demo
import Lib

data class Cols(Id string)

func Run(migrationBuilder MigrationBuilder) {
    migrationBuilder.CreateTable[Cols]("Accounts", (table ColumnsBuilder) -> Cols{Id: table.Column("id")}, "dbo", (table CreateTableBuilder[Cols]) -> {
        table.Annotation("foo", "bar")
    })
}`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0159")
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
    }

    @Fact
    func ShorterOverloadWithoutConstraintsLambdaStillResolves() {
        let result = CompileAgainstLibrary(`package Demo
import Lib

data class Cols(Id string)

func Run(migrationBuilder MigrationBuilder) {
    migrationBuilder.CreateTable("Accounts", (table ColumnsBuilder) -> Cols{Id: table.Column("id")})
}`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0159")
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
    }

    @Fact
    func BlockedLambdaAtEarlierParameterPositionStillClosesTypeParameterForLaterOnes() {
        // The block-bodied lambda that is blocked by the open generic parameter appears BEFORE the
        // lambda that actually closes TColumns, verifying the fix is parameter-position independent
        // (not hard-coded to "second lambda argument").
        let result = CompileAgainstLibrary(`package Demo
import Lib

data class Cols(Id string)

func Run(migrationBuilder MigrationBuilder) {
    migrationBuilder.CreateReordered("Accounts", (table CreateTableBuilder[Cols]) -> {
        table.Annotation("a", "b")
    }, (table ColumnsBuilder) -> Cols{Id: table.Column("id")})
}`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0159")
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
    }

    @Fact
    func ExplicitTypeArgumentsWithSingleVoidReturningActionLambdaStillResolve() {
        // Explicit type-argument-only scenario (no output-inferring lambda at all): TColumns is closed
        // purely from the explicit type argument, and the sole lambda argument is Action-shaped.
        let result = CompileAgainstLibrary(`package Demo
import Lib

data class Cols(Id string)

func Run(migrationBuilder MigrationBuilder) {
    migrationBuilder.Configure[Cols]("t", (table CreateTableBuilder[Cols]) -> {
        table.Annotation("a", "b")
    })
}`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0159")
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
    }

    @Fact
    func ArityMismatchOnDeferredLambdaStillFailsWithDiagnostic() {
        let result = CompileAgainstLibrary(`package Demo
import Lib

data class Cols(Id string)

func Run(migrationBuilder MigrationBuilder) {
    migrationBuilder.CreateTable("Accounts", (table ColumnsBuilder) -> Cols{Id: table.Column("id")}, "dbo", (table CreateTableBuilder[Cols], extra string) -> {
        table.Annotation("a", "b")
    })
}`, expectSuccess: false)
        Assert.False(result.Success)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0159")
    }

    @Fact
    func WrongParameterTypeOnOutputInferringLambdaStillFailsWithDiagnostic() {
        let result = CompileAgainstLibrary(`package Demo
import Lib

data class Cols(Id string)

func Run(migrationBuilder MigrationBuilder) {
    migrationBuilder.CreateTable("Accounts", (wrongParam int32) -> Cols{Id: "x"}, "dbo", (table CreateTableBuilder[Cols]) -> {
        table.Annotation("a", "b")
    })
}`, expectSuccess: false)
        Assert.False(result.Success)
        Assert.Contains(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0159")
    }

    /// Synthetic reconstruction of the reported "Oahu.Data migration" regression: a generic
    /// `CreateTable<TColumns>(name, columns, schema, constraints)` shape closely mirroring EF
    /// Core's `MigrationBuilder.CreateTable<TColumns>`, exercised with the same argument shape
    /// (string literal name, an output-inferring first lambda, a nullable/optional-looking schema string,
    /// and a trailing block-bodied constraints lambda whose body ends on a fluent self-returning call) as
    /// the field-reported failure.
    @Fact
    func OahuDataStyleMigrationRegressionCompiles() {
        let result = CompileAgainstLibrary(`package Demo
import Lib

data class Cols(Id string, Name string)

func Up(migrationBuilder MigrationBuilder) {
    migrationBuilder.CreateTable(
        "Accounts",
        (table ColumnsBuilder) -> Cols{
            Id: table.Column("id"),
            Name: table.Column("name"),
        },
        "dbo",
        (table CreateTableBuilder[Cols]) -> {
            table.Annotation("Sqlite:Autoincrement", true)
        })
}`)
        Assert.DoesNotContain(result.Diagnostics, (d Diagnostic) -> d.Id == "GS0159")
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
    }

    shared {
        private func CompileAgainstLibrary(consumerSource string, expectSuccess bool = true) EmitResult {
            let outputDir = Path.Combine(AppContext.BaseDirectory, "Issue2345")
            Directory.CreateDirectory(outputDir)
            let libraryPath = Path.Combine(outputDir, "Issue2345.Library.dll")
            EmitLibraryAssembly(libraryPath)
            using let resolver = ReferenceResolver.WithReferences([]string{libraryPath})
            let consumer = Compilation(resolver, SyntaxTree.Parse(SourceText.From(consumerSource)))
            using let peStream = MemoryStream()
            let result = consumer.Emit(
                peStream,
                pdbStream: nil,
                refStream: nil,
                assemblyName: "Issue2345.Consumer." + Guid.NewGuid().ToString("N")
            )
            return result
        }

        private func EmitLibraryAssembly(libraryPath string) {
            if File.Exists(libraryPath) {
                // Reused across [Fact]s in this class; each test compiles a distinct consumer assembly
                // against the same cached library, mirroring Issue2142's pattern.
                return
            }
            let library = Compilation(SyntaxTree.Parse(SourceText.From(`package Lib
import System

class ColumnsBuilder {
    func Column(name string) string { return name }
}

class CreateTableBuilder[TColumns] {
    func Annotation(name string, value object) CreateTableBuilder[TColumns] { return CreateTableBuilder[TColumns]{} }
}

class MigrationBuilder {
    func CreateTable[TColumns](name string, columns Func[ColumnsBuilder, TColumns], schema string, constraints Action[CreateTableBuilder[TColumns]]) TColumns {
        return columns(ColumnsBuilder{})
    }

    func CreateTable[TColumns](name string, columns Func[ColumnsBuilder, TColumns]) TColumns {
        return columns(ColumnsBuilder{})
    }

    func CreateReordered[TColumns](name string, constraints Action[CreateTableBuilder[TColumns]], columns Func[ColumnsBuilder, TColumns]) TColumns {
        return columns(ColumnsBuilder{})
    }

    func Configure[TColumns](name string, configure Action[CreateTableBuilder[TColumns]]) {
    }
}`))){IsLibrary = true}
            using let peStream = File.Create(libraryPath)
            let result = library.Emit(peStream, pdbStream: nil, refStream: nil, assemblyName: "Issue2345.Library")
            Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
        }
    }
}
