// <copyright file="MissingOptionValueException.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;

namespace Cs2Gs.Cli;

/// <summary>
/// Sentinel exception thrown when a command-line option's value is missing.
/// </summary>
internal sealed class MissingOptionValueException : ArgumentException
{
    public MissingOptionValueException(string message)
        : base(message)
    {
    }
}
