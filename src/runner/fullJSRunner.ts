/* eslint-disable @typescript-eslint/no-unused-vars */
import { Options, parse } from 'acorn'
import { generate } from 'astring'
import * as es from 'estree'

import { IOptions, ModuleContext, Result } from '..'
import { NATIVE_STORAGE_ID } from '../constants'
import { RuntimeSourceError } from '../errors/runtimeSourceError'
import { FatalSyntaxError } from '../parser/parser'
import { evallerReplacer, getBuiltins, prefixModule, transpile } from '../transpiler/transpiler'
import { Context } from '../types'
import * as create from '../utils/astCreator'
import { NativeStorage } from './../types'
import { hoistImportDeclarations } from '.'
import { toSourceError } from './errors'
import { appendModulesToContext, resolvedErrorPromise } from './utils'

const FULL_JS_PARSER_OPTIONS: Options = {
  sourceType: 'module',
  ecmaVersion: 'latest',
  locations: true
}

/**
 * Parse code string into AST
 * - any errors in the process of parsing will be added to the context
 *
 * @param code
 * @param context
 * @returns AST of code if there are no syntax errors, otherwise undefined
 */
function parseFullJS(code: string, context: Context): es.Program | undefined {
  let program: es.Program | undefined
  try {
    program = parse(code, FULL_JS_PARSER_OPTIONS) as unknown as es.Program
  } catch (error) {
    if (error instanceof SyntaxError) {
      const loc = (error as any).loc
      const location = {
        start: { line: loc.line, column: loc.column },
        end: { line: loc.line, column: loc.column + 1 }
      }
      context.errors.push(new FatalSyntaxError(location, error.toString()))
    }
  }

  return program
}

function fullJSEval(
  code: string,
  nativeStorage: NativeStorage,
  moduleParams: any,
  moduleContexts: Map<string, ModuleContext>
): any {
  if (nativeStorage.evaller) {
    return nativeStorage.evaller(code)
  } else {
    return eval(code)
  }
}

function preparePrelude(context: Context): es.Statement[] {
  if (context.prelude === null) {
    return []
  }
  const prelude = context.prelude
  context.prelude = null
  const program: es.Program = parseFullJS(prelude, context)!

  return program.body as es.Statement[]
}

export async function fullJSRunner(
  code: string,
  context: Context,
  options: Partial<IOptions> = {}
): Promise<Result> {
  // parse + check for syntax errors
  const program: es.Program | undefined = parseFullJS(code, context)
  if (!program) {
    return resolvedErrorPromise
  }

  hoistImportDeclarations(program)

  // prelude & builtins
  // TODO resolve repeated declaration in prelude and builtins
  context.nativeStorage.builtins.delete('list_to_stream')
  const preludeBuiltInStatements: es.Statement[] = [
    ...getBuiltins(context.nativeStorage),
    ...preparePrelude(context),
    evallerReplacer(create.identifier(NATIVE_STORAGE_ID), new Set())
  ]

  // modules
  try {
    appendModulesToContext(program, context)
  } catch (error) {
    if (error instanceof RuntimeSourceError) {
      context.errors.push(error)
      return resolvedErrorPromise
    }
    throw error
  }

  const modulePrefix: string = prefixModule(program)

  const preEvalProgram: es.Program = create.program(preludeBuiltInStatements)
  const preEvalCode: string = generate(preEvalProgram) + modulePrefix
  await fullJSEval(preEvalCode, context.nativeStorage, options, context.moduleContexts)

  const { transpiled, sourceMapJson } = transpile(program, context)
  try {
    return Promise.resolve({
      status: 'finished',
      context,
      value: await fullJSEval(transpiled, context.nativeStorage, options, context.moduleContexts)
    })
  } catch (error) {
    context.errors.push(await toSourceError(error, sourceMapJson))
    return resolvedErrorPromise
  }
}
