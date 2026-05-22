// <copyright file="Compilation.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Threading;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Emit;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Binder = GSharp.Core.CodeAnalysis.Binding.Binder;

namespace GSharp.Core.CodeAnalysis.Compilation;

/// <summary>
/// Chained compilation facilities.
/// </summary>
public class Compilation
{
    private BoundGlobalScope globalScope;

    /// <summary>
    /// Initializes a new instance of the <see cref="Compilation"/> class.
    /// </summary>
    /// <param name="syntaxTrees">The syntax trees.</param>
    public Compilation(params SyntaxTree[] syntaxTrees)
        : this(null, references: null, syntaxTrees)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="Compilation"/> class with
    /// an explicit reference resolver.
    /// </summary>
    /// <param name="references">The reference resolver to use for imported CLR type lookups.</param>
    /// <param name="syntaxTrees">The syntax trees.</param>
    public Compilation(ReferenceResolver references, params SyntaxTree[] syntaxTrees)
        : this(null, references, syntaxTrees)
    {
    }

    private Compilation(Compilation previous, ReferenceResolver references, SyntaxTree[] syntaxTrees)
    {
        Previous = previous;
        SyntaxTrees = syntaxTrees.ToImmutableArray();
        References = references ?? previous?.References;
        ImplicitSystemImport = previous?.ImplicitSystemImport ?? true;
    }

    /// <summary>
    /// Gets the previous compilation.
    /// </summary>
    public Compilation Previous { get; }

    /// <summary>
    /// Gets the syntax trees.
    /// </summary>
    public ImmutableArray<SyntaxTree> SyntaxTrees { get; }

    /// <summary>
    /// Gets the reference resolver used to look up imported CLR types.
    /// </summary>
    public ReferenceResolver References { get; }

    /// <summary>
    /// Gets or sets a value indicating whether an implicit <c>import System</c>
    /// should be seeded before user imports are processed. Defaults to
    /// <see langword="true"/>.
    /// </summary>
    public bool ImplicitSystemImport { get; set; }

    /// <summary>
    /// Gets the global scope.
    /// </summary>
    public BoundGlobalScope GlobalScope
    {
        get
        {
            if (globalScope == null)
            {
                var globalScope = Binder.BindGlobalScope(Previous?.GlobalScope, SyntaxTrees, References, ImplicitSystemImport);
                Interlocked.CompareExchange(ref this.globalScope, globalScope, null);
            }

            return globalScope;
        }
    }

    /// <summary>
    /// Continue the compilation with the specified syntax tree chained to the
    /// current compilation.
    /// </summary>
    /// <param name="syntaxTrees">The new syntax trees.</param>
    /// <returns>The chained compilation.</returns>
    public Compilation ContinueWith(params SyntaxTree[] syntaxTrees)
    {
        return new Compilation(this, references: null, syntaxTrees);
    }

    /// <summary>
    /// Evaluates the current compilation provided a symbol table with actual values.
    /// </summary>
    /// <param name="variables">The symbol table with actual values.</param>
    /// <returns>An evaluation result.</returns>
    public EvaluationResult Evaluate(Dictionary<VariableSymbol, object> variables)
    {
        var parseDiagnostics = SyntaxTrees.SelectMany(st => st.Diagnostics);
        var diagnostics = parseDiagnostics.Concat(GlobalScope.Diagnostics).ToImmutableArray();
        if (diagnostics.Any())
        {
            return new EvaluationResult(diagnostics, null);
        }

        var program = Binder.BindProgram(GlobalScope);

        var appPath = Environment.GetCommandLineArgs()[0];
        var appDirectory = Path.GetDirectoryName(appPath);
        var cfgPath = Path.Combine(appDirectory, "cfg.dot");
        var cfgStatement = !program.Statement.Statements.Any() && program.Functions.Any()
                              ? program.Functions.Last().Value
                              : program.Statement;
        var cfg = ControlFlowGraph.Create(cfgStatement);
        using (var streamWriter = new StreamWriter(cfgPath))
        {
            cfg.WriteTo(streamWriter);
        }

        if (program.Diagnostics.Any())
        {
            return new EvaluationResult(program.Diagnostics.ToImmutableArray(), null);
        }

        var evaluator = new Evaluator(program, variables);
        try
        {
            var value = evaluator.Evaluate();
            return new EvaluationResult(ImmutableArray<Diagnostic>.Empty, value);
        }
        catch (EvaluatorException ex)
        {
            using var textWriter = new StringWriter();
            ex.Node?.WriteTo(textWriter);
            var sourceText = SourceText.From(textWriter.ToString());
            var location = new TextLocation(sourceText, new TextSpan(0, sourceText.Length));
            var message = ex.Message;
            var diagnostic = new Diagnostic(location, message);
            return new EvaluationResult(ImmutableArray.Create(diagnostic), null);
        }
    }

    /// <summary>
    /// Emits a tree for this program to the specified writer.
    /// </summary>
    /// <param name="writer">The writer.</param>
    public void EmitTree(TextWriter writer)
    {
        var program = Binder.BindProgram(GlobalScope);

        if (program.Statement.Statements.Any())
        {
            program.Statement.WriteTo(writer);
        }
        else
        {
            foreach (var functionBody in program.Functions)
            {
                if (!GlobalScope.Functions.Contains(functionBody.Key))
                {
                    continue;
                }

                functionBody.Key.WriteTo(writer);
                functionBody.Value.WriteTo(writer);
            }
        }
    }

    /// <summary>
    /// Compiles the current syntax tree into a compilation result. The
    /// resulting assembly is written to <c>{PackageName}.dll</c> in the
    /// current working directory.
    /// </summary>
    /// <returns>An emit result.</returns>
    public EmitResult Emit()
    {
        var parseDiagnostics = SyntaxTrees.SelectMany(st => st.Diagnostics);
        var syntaxDiagnostics = parseDiagnostics.Concat(GlobalScope.Diagnostics).ToImmutableArray();
        if (syntaxDiagnostics.Any())
        {
            return new EmitResult(success: false, syntaxDiagnostics);
        }

        var program = Binder.BindProgram(GlobalScope);
        if (program.Diagnostics.Any())
        {
            return new EmitResult(success: false, program.Diagnostics.ToImmutableArray());
        }

        try
        {
            using var stream = File.Create(program.PackageName + ".dll");
            EmitAssembly(program, stream, References);
        }
        catch (Exception ex) when (ex is NotSupportedException || ex is InvalidOperationException)
        {
            var location = new TextLocation(SourceText.From(string.Empty), new TextSpan(0, 0));
            var diagnostic = new Diagnostic(location, ex.Message);
            return new EmitResult(success: false, ImmutableArray.Create(diagnostic));
        }

        return new EmitResult(success: true, diagnostics: ImmutableArray<Diagnostic>.Empty);
    }

    /// <summary>
    /// Compiles the current syntax tree and writes the resulting assembly to
    /// <paramref name="peStream"/>. Useful for tests that don't want to touch
    /// the filesystem.
    /// </summary>
    /// <param name="peStream">Destination stream for the PE bytes.</param>
    /// <param name="assemblyName">Optional override for the assembly identity. When null, the entry-point package name is used.</param>
    /// <returns>An emit result.</returns>
    public EmitResult Emit(Stream peStream, string assemblyName = null)
    {
        var parseDiagnostics = SyntaxTrees.SelectMany(st => st.Diagnostics);
        var syntaxDiagnostics = parseDiagnostics.Concat(GlobalScope.Diagnostics).ToImmutableArray();
        if (syntaxDiagnostics.Any())
        {
            return new EmitResult(success: false, syntaxDiagnostics);
        }

        var program = Binder.BindProgram(GlobalScope);
        if (program.Diagnostics.Any())
        {
            return new EmitResult(success: false, program.Diagnostics.ToImmutableArray());
        }

        try
        {
            EmitAssembly(program, peStream, References, assemblyName);
        }
        catch (Exception ex) when (ex is NotSupportedException || ex is InvalidOperationException)
        {
            var location = new TextLocation(SourceText.From(string.Empty), new TextSpan(0, 0));
            var diagnostic = new Diagnostic(location, ex.Message);
            return new EmitResult(success: false, ImmutableArray.Create(diagnostic));
        }

        return new EmitResult(success: true, diagnostics: ImmutableArray<Diagnostic>.Empty);
    }

    private static void EmitAssembly(BoundProgram program, Stream peStream, ReferenceResolver references, string assemblyName = null)
    {
        ReflectionMetadataEmitter.Emit(program, peStream, references, assemblyName);
    }
}
