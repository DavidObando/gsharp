// <copyright file="GSharpCodeFixProviderAttribute.gs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.CodeFixes

import System

/// Marks a (cref:GSharpCodeFixProvider) that (cref:GSharp.Core.CodeAnalysis.Analyzers.GSharpAnalyzerHost)
/// loads from an analyzer assembly (ADR-0227 D2).
@AttributeUsage(AttributeTargets.Class, AllowMultiple = false, Inherited = false)
class GSharpCodeFixProviderAttribute : Attribute { }
