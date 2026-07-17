// <copyright file="DiagnosticDescriptor.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

namespace GSharp.Core.CodeAnalysis;

internal readonly record struct DiagnosticDescriptor(
    string Id,
    DiagnosticSeverity Severity,
    string MessageFormat);
