// <copyright file="Issue2345StagedLambdaInferenceTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.IO;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// Issue #2345: an imported generic method with MULTIPLE lambda arguments (e.g. EF Core's
/// <c>MigrationBuilder.CreateTable&lt;TColumns&gt;(name, columns, schema, constraints)</c>) failed to
/// bind when a LATER block-bodied lambda argument's delegate-target parameter type contained an open
/// generic method type parameter (e.g. <c>Action&lt;CreateTableBuilder&lt;TColumns&gt;&gt;</c>) that only
/// closes once an EARLIER lambda argument (e.g. <c>Func&lt;ColumnsBuilder, TColumns&gt;</c>) has been
/// bound and its output inferred.
///
/// Root cause: without a resolvable delegate target, a block-bodied lambda's implicit return type was
/// incorrectly inferred from the VALUE of its trailing statement rather than defaulting to
/// <c>void</c>. When that trailing statement was a fluent/self-returning method call (EF's
/// <c>Annotation(string, object)</c> returning <c>CreateTableBuilder&lt;TColumns&gt;</c>), this produced a
/// value-returning <c>Func&lt;…&gt;</c>-shaped lambda instead of the expected <c>void</c>-returning
/// <c>Action&lt;…&gt;</c>-shaped one, so the outer generic call's overload resolution reported
/// <c>NoneApplicable</c>, cascading to a misleading GS0159 "Cannot find function" diagnostic.
///
/// The fix generalizes the existing deferred/probe lambda-binding infrastructure (issue #903's symbolic
/// deferred-lambda-target recovery): a block-bodied lambda argument whose delegate target is blocked
/// solely by an open generic method type parameter is now DEFERRED (instead of eagerly bound with no
/// target) until the outer call's other arguments have contributed enough information to close the
/// method's type parameters, at which point the delegate's real (possibly <c>void</c>) return type is
/// recovered and used, restoring the correct "block body defaults to <c>void</c>" semantics. This is
/// EF-agnostic: it applies to any imported (or source) generic method, at any lambda parameter position,
/// for <c>Action</c>/<c>Func</c>/<c>Expression&lt;Func&lt;…&gt;&gt;</c> shapes, with or without explicit
/// type arguments.
/// </summary>
public class Issue2345StagedLambdaInferenceTests
{
    [Fact]
    public void LaterBlockBodiedLambdaWithFluentTrailingCallInfersVoidAfterEarlierLambdaClosesTypeParameter()
    {
        var result = CompileAgainstLibrary(
            """
            package Demo
            import Lib

            data class Cols(Id string)

            func Run(migrationBuilder MigrationBuilder) {
                migrationBuilder.CreateTable("Accounts", (table ColumnsBuilder) -> Cols{Id: table.Column("id")}, "dbo", (table CreateTableBuilder[Cols]) -> {
                    table.Annotation("foo", "bar")
                })
            }
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0159");
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }

    [Fact]
    public void MultipleFluentCallsInsideConstraintsLambdaBodyStillInfersVoid()
    {
        var result = CompileAgainstLibrary(
            """
            package Demo
            import Lib

            data class Cols(Id string)

            func Run(migrationBuilder MigrationBuilder) {
                migrationBuilder.CreateTable("Accounts", (table ColumnsBuilder) -> Cols{Id: table.Column("id")}, "dbo", (table CreateTableBuilder[Cols]) -> {
                    table.Annotation("a", "b")
                    table.Annotation("c", "d")
                })
            }
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0159");
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }

    [Fact]
    public void EmptyConstraintsLambdaBodyStillBinds()
    {
        var result = CompileAgainstLibrary(
            """
            package Demo
            import Lib

            data class Cols(Id string)

            func Run(migrationBuilder MigrationBuilder) {
                migrationBuilder.CreateTable("Accounts", (table ColumnsBuilder) -> Cols{Id: table.Column("id")}, "dbo", (table CreateTableBuilder[Cols]) -> {
                })
            }
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0159");
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }

    [Fact]
    public void ExplicitOuterTypeArgumentsStillResolve()
    {
        var result = CompileAgainstLibrary(
            """
            package Demo
            import Lib

            data class Cols(Id string)

            func Run(migrationBuilder MigrationBuilder) {
                migrationBuilder.CreateTable[Cols]("Accounts", (table ColumnsBuilder) -> Cols{Id: table.Column("id")}, "dbo", (table CreateTableBuilder[Cols]) -> {
                    table.Annotation("foo", "bar")
                })
            }
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0159");
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }

    [Fact]
    public void ShorterOverloadWithoutConstraintsLambdaStillResolves()
    {
        var result = CompileAgainstLibrary(
            """
            package Demo
            import Lib

            data class Cols(Id string)

            func Run(migrationBuilder MigrationBuilder) {
                migrationBuilder.CreateTable("Accounts", (table ColumnsBuilder) -> Cols{Id: table.Column("id")})
            }
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0159");
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }

    [Fact]
    public void BlockedLambdaAtEarlierParameterPositionStillClosesTypeParameterForLaterOnes()
    {
        // The block-bodied lambda that is blocked by the open generic parameter appears BEFORE the
        // lambda that actually closes TColumns, verifying the fix is parameter-position independent
        // (not hard-coded to "second lambda argument").
        var result = CompileAgainstLibrary(
            """
            package Demo
            import Lib

            data class Cols(Id string)

            func Run(migrationBuilder MigrationBuilder) {
                migrationBuilder.CreateReordered("Accounts", (table CreateTableBuilder[Cols]) -> {
                    table.Annotation("a", "b")
                }, (table ColumnsBuilder) -> Cols{Id: table.Column("id")})
            }
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0159");
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }

    [Fact]
    public void ExplicitTypeArgumentsWithSingleVoidReturningActionLambdaStillResolve()
    {
        // Explicit type-argument-only scenario (no output-inferring lambda at all): TColumns is closed
        // purely from the explicit type argument, and the sole lambda argument is Action-shaped.
        var result = CompileAgainstLibrary(
            """
            package Demo
            import Lib

            data class Cols(Id string)

            func Run(migrationBuilder MigrationBuilder) {
                migrationBuilder.Configure[Cols]("t", (table CreateTableBuilder[Cols]) -> {
                    table.Annotation("a", "b")
                })
            }
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0159");
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }

    [Fact]
    public void ArityMismatchOnDeferredLambdaStillFailsWithDiagnostic()
    {
        var result = CompileAgainstLibrary(
            """
            package Demo
            import Lib

            data class Cols(Id string)

            func Run(migrationBuilder MigrationBuilder) {
                migrationBuilder.CreateTable("Accounts", (table ColumnsBuilder) -> Cols{Id: table.Column("id")}, "dbo", (table CreateTableBuilder[Cols], extra string) -> {
                    table.Annotation("a", "b")
                })
            }
            """,
            expectSuccess: false);

        Assert.False(result.Success);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0159");
    }

    [Fact]
    public void WrongParameterTypeOnOutputInferringLambdaStillFailsWithDiagnostic()
    {
        var result = CompileAgainstLibrary(
            """
            package Demo
            import Lib

            data class Cols(Id string)

            func Run(migrationBuilder MigrationBuilder) {
                migrationBuilder.CreateTable("Accounts", (wrongParam int32) -> Cols{Id: "x"}, "dbo", (table CreateTableBuilder[Cols]) -> {
                    table.Annotation("a", "b")
                })
            }
            """,
            expectSuccess: false);

        Assert.False(result.Success);
        Assert.Contains(result.Diagnostics, d => d.Id == "GS0159");
    }

    /// <summary>
    /// Synthetic reconstruction of the reported "Oahu.Data migration" regression: a generic
    /// <c>CreateTable&lt;TColumns&gt;(name, columns, schema, constraints)</c> shape closely mirroring EF
    /// Core's <c>MigrationBuilder.CreateTable&lt;TColumns&gt;</c>, exercised with the same argument shape
    /// (string literal name, an output-inferring first lambda, a nullable/optional-looking schema string,
    /// and a trailing block-bodied constraints lambda whose body ends on a fluent self-returning call) as
    /// the field-reported failure.
    /// </summary>
    [Fact]
    public void OahuDataStyleMigrationRegressionCompiles()
    {
        var result = CompileAgainstLibrary(
            """
            package Demo
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
            }
            """);

        Assert.DoesNotContain(result.Diagnostics, d => d.Id == "GS0159");
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }

    private static EmitResult CompileAgainstLibrary(string consumerSource, bool expectSuccess = true)
    {
        var outputDir = Path.Combine(AppContext.BaseDirectory, "Issue2345");
        Directory.CreateDirectory(outputDir);

        var libraryPath = Path.Combine(outputDir, "Issue2345.Library.dll");
        EmitLibraryAssembly(libraryPath);

        using var resolver = ReferenceResolver.WithReferences(new[] { libraryPath });

        var consumer = new Compilation(resolver, SyntaxTree.Parse(SourceText.From(consumerSource)));

        using var peStream = new MemoryStream();
        var result = consumer.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Issue2345.Consumer." + Guid.NewGuid().ToString("N"));

        _ = expectSuccess;
        return result;
    }

    private static void EmitLibraryAssembly(string libraryPath)
    {
        if (File.Exists(libraryPath))
        {
            // Reused across [Fact]s in this class; each test compiles a distinct consumer assembly
            // against the same cached library, mirroring Issue2142's pattern.
            return;
        }

        var library = new Compilation(
            SyntaxTree.Parse(SourceText.From(
                """
                package Lib
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
                }
                """)))
        {
            IsLibrary = true,
        };

        using var peStream = File.Create(libraryPath);
        var result = library.Emit(peStream, pdbStream: null, refStream: null, assemblyName: "Issue2345.Library");
        Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics));
    }
}
