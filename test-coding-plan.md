# GSharp Project Test Implementation Plan

## Overview

This document outlines a comprehensive plan to implement missing tests for the GSharp compiler/interpreter project, addressing the critical coverage gaps identified in the test coverage report.

## Testing Framework Strategy

### Primary Framework: xUnit
- **Reason:** Already in use, excellent .NET integration, rich assertion library
- **Extensions:** 
  - `FluentAssertions` for readable assertions
  - `Moq` for mocking dependencies
  - `AutoFixture` for test data generation

### Specialized Testing Tools
- **Coverlet:** Code coverage analysis
- **BenchmarkDotNet:** Performance testing
- **FsCheck:** Property-based testing for parser robustness

## Implementation Phases

### Phase 1: Foundation Tests (Week 1-2)
**Goal:** Establish core testing infrastructure and test critical path components

#### 1.1 Text Processing Tests (`Core.Tests/CodeAnalysis/Text/`)
- **TextSpanTests.cs**
  - Constructor validation
  - Boundary operations (Start, End, Length)
  - Comparison operations
  - Edge cases (empty spans, negative values)
  - `FromBounds` static method

- **TextLineTests.cs**
  - Line creation and properties
  - Text span integration
  - Line enumeration

- **Enhanced SourceTextTests.cs**
  - Line enumeration edge cases
  - Character indexing
  - Unicode handling
  - Large file handling
  - Memory efficiency tests

#### 1.2 Diagnostic System Tests (`Core.Tests/CodeAnalysis/`)
- **DiagnosticTests.cs**
  - Diagnostic creation and properties
  - Severity levels
  - Message formatting
  - Location tracking

- **DiagnosticBagTests.cs**
  - Error collection operations
  - Filtering by severity
  - Enumeration patterns
  - Thread safety (if applicable)

#### 1.3 Symbol System Foundation (`Core.Tests/CodeAnalysis/Symbols/`)
- **SymbolTests.cs**
  - Base symbol functionality
  - Name validation
  - ToString behavior
  - WriteTo functionality

- **TypeSymbolTests.cs**
  - Built-in type creation
  - Type equivalence
  - Type compatibility checking

### Phase 2: Language Processing Core (Week 3-4)
**Goal:** Test the heart of the language processing pipeline

#### 2.1 Lexical Analysis Tests (`Core.Tests/CodeAnalysis/Syntax/`)
- **LexerTests.cs**
  - Token recognition for all language constructs
  - Keyword vs identifier distinction
  - Number literal parsing (integers, floats)
  - String literal parsing (escape sequences, unicode)
  - Comment handling
  - Whitespace handling
  - Error recovery for invalid tokens
  - Position tracking accuracy

#### 2.2 Syntax Analysis Tests
- **ParserTests.cs**
  - Expression parsing (precedence, associativity)
  - Statement parsing (declarations, assignments, control flow)
  - Error recovery strategies
  - Incomplete input handling
  - Large AST construction

- **SyntaxNodeTests.cs**
  - Node creation and properties
  - Parent-child relationships
  - Visitor pattern implementation
  - Serialization/deserialization

- **SyntaxFactsTests.cs**
  - Keyword recognition
  - Operator precedence
  - Token text mapping
  - Binary/unary operator classification

#### 2.3 Parsing Integration Tests
- **CompilationUnitTests.cs**
  - Package declaration parsing
  - Import statement parsing
  - Function declaration parsing
  - Complete program parsing

### Phase 3: Semantic Analysis (Week 5-6)
**Goal:** Test semantic analysis and type checking

#### 3.1 Binding Tests (`Core.Tests/CodeAnalysis/Binding/`)
- **BinderTests.cs**
  - Expression binding (literals, variables, operations)
  - Statement binding (assignments, control flow)
  - Function call binding
  - Type checking and conversion
  - Error reporting for semantic errors
  - Symbol resolution

- **BoundNodeTests.cs**
  - Bound node creation and properties
  - Node kind verification
  - Tree structure validation

- **BoundScopeTests.cs**
  - Variable declaration and lookup
  - Function declaration and lookup
  - Scope nesting and shadowing
  - Import handling

- **ConversionTests.cs**
  - Implicit conversions (int to float, etc.)
  - Explicit conversions
  - Conversion failure scenarios
  - Identity conversions

#### 3.2 Control Flow Analysis Tests
- **ControlFlowGraphTests.cs**
  - Basic block construction
  - Branch analysis
  - Unreachable code detection
  - Loop analysis
  - Return path validation

### Phase 4: Code Generation and Execution (Week 7-8)
**Goal:** Test compilation output and program execution

#### 4.1 Evaluation Tests (`Core.Tests/CodeAnalysis/`)
- **EvaluatorTests.cs**
  - Expression evaluation (arithmetic, logical, comparison)
  - Variable assignment and retrieval
  - Function call execution
  - Built-in function execution
  - Control flow execution (if/else, loops)
  - Error handling during execution

- **EvaluationResultTests.cs**
  - Result value handling
  - Error result handling
  - Result type validation

#### 4.2 Built-in Functions Tests
- **BuiltinFunctionsTests.cs**
  - Print function behavior
  - Input function behavior (mocked input)
  - Random number generation
  - Function signature validation
  - Parameter type checking

#### 4.3 Compilation Tests (`Core.Tests/CodeAnalysis/Compilation/`)
- **CompilationTests.cs**
  - End-to-end compilation workflow
  - Multiple file compilation
  - Dependency resolution
  - Error aggregation
  - Success/failure scenarios

- **EmitResultTests.cs**
  - Success result validation
  - Error result handling
  - Diagnostic collection

### Phase 5: Advanced Features (Week 9-10)
**Goal:** Test advanced language features and optimizations

#### 5.1 Lowering Tests (`Core.Tests/CodeAnalysis/Lowering/`)
- **LowererTests.cs**
  - For loop lowering to while loops
  - Complex expression simplification
  - Control flow normalization
  - Tree rewriting correctness

#### 5.2 PE Generation Tests (`Core.Tests/CodeAnalysis/PEWriter/`)
- **PEWriterTests.cs** (if implementation exists)
  - Assembly generation
  - Metadata writing
  - Executable creation
  - Cross-platform compatibility

### Phase 6: Tool Integration Tests (Week 11-12)
**Goal:** Test command-line tools and REPL functionality

#### 6.1 Compiler Tool Tests (`GSharp.Tests/Compiler/`)
- **CompilerProgramTests.cs**
  - Command-line argument parsing
  - File input/output handling
  - Error reporting to console
  - Exit code validation

#### 6.2 Interpreter Tool Tests (`GSharp.Tests/Interpreter/`)
- **InterpreterProgramTests.cs**
  - File execution mode
  - REPL mode initialization
  - Command-line argument handling

- **GSharpReplTests.cs**
  - Interactive expression evaluation
  - Multi-line input handling
  - Command processing (#show, #cls, etc.)
  - Error display in REPL

- **ReplTests.cs**
  - Generic REPL infrastructure
  - Input processing
  - History management
  - Display functionality

#### 6.3 Language Server Tests (`GSharp.Tests/LanguageServer/`)
- **LanguageServerTests.cs**
  - LSP message handling
  - Document synchronization
  - Error reporting to client

## Test Categories and Patterns

### Unit Tests
```csharp
[Fact]
public void TestMethod_Scenario_ExpectedBehavior()
{
    // Arrange
    var input = CreateTestInput();
    
    // Act
    var result = SystemUnderTest.Method(input);
    
    // Assert
    result.Should().Be(expectedValue);
}
```

### Parameterized Tests
```csharp
[Theory]
[InlineData("input1", "expected1")]
[InlineData("input2", "expected2")]
public void TestMethod_VariousInputs_CorrectResults(string input, string expected)
{
    // Test implementation
}
```

### Integration Tests
```csharp
[Fact]
public void CompileAndExecute_ValidProgram_ProducesExpectedOutput()
{
    // Test complete compilation pipeline
}
```

### Property-Based Tests
```csharp
[Property]
public void Parser_ValidInput_AlwaysProducesValidAST(ValidGSharpProgram program)
{
    // Property-based testing with generated inputs
}
```

## Test Data Strategy

### 1. Sample Programs
Create a library of sample GSharp programs for testing:
- **Valid programs:** Various language constructs
- **Invalid programs:** Syntax and semantic errors
- **Edge cases:** Empty files, large files, complex nesting

### 2. Test Fixtures
- **Golden files:** Expected parser outputs
- **Error catalogs:** Expected error messages
- **Performance baselines:** Compilation time expectations

### 3. Mock Objects
- **IO mocking:** File system, console input/output
- **Random mocking:** Deterministic testing of random functions
- **Time mocking:** Reproducible time-dependent tests

## Continuous Integration

### GitHub Actions Workflow
```yaml
name: Tests
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
      - name: Setup .NET
        uses: actions/setup-dotnet@v1
        with:
          dotnet-version: 6.0.x
      - name: Run tests
        run: dotnet test --collect:"XPlat Code Coverage"
      - name: Generate coverage report
        run: reportgenerator -reports:**/coverage.cobertura.xml -targetdir:coverage
```

### Coverage Goals
- **Core library:** 95% line coverage
- **Tools:** 80% line coverage
- **Overall project:** 90% line coverage

### Quality Gates
- All tests must pass
- Coverage thresholds must be met
- No new warnings introduced
- Performance regression detection

## Implementation Schedule

### Week 1-2: Foundation
- Text processing tests
- Diagnostic system tests
- Basic symbol tests
- Test infrastructure setup

### Week 3-4: Language Core
- Lexer comprehensive tests
- Parser comprehensive tests
- Syntax tree tests

### Week 5-6: Semantics
- Binding tests
- Type checking tests
- Scope resolution tests

### Week 7-8: Execution
- Evaluator tests
- Compilation tests
- Built-in function tests

### Week 9-10: Advanced
- Lowering tests
- Optimization tests
- PE generation tests

### Week 11-12: Integration
- Tool tests
- End-to-end tests
- Performance tests

## Success Metrics

### Quantitative Goals
- Achieve 90%+ overall code coverage
- Implement 500+ test methods
- Reduce bug discovery time by 80%
- Establish 100ms maximum test suite runtime

### Qualitative Goals
- Increase developer confidence in changes
- Enable safe refactoring
- Improve code quality through TDD
- Establish comprehensive regression prevention

This plan provides a systematic approach to achieving comprehensive test coverage for the GSharp project, ensuring reliability and maintainability of the codebase.
