local function ctlsub(c)
	if c == "\n" then return "\\n"
	elseif c == "\r" then return "\\r"
	elseif c == "\t" then return "\\t"
	--elseif c == "\\" then return "\\\\"
	--elseif c == "\"" then return "\\\""
	else return string.format("\\%03d", string.byte(c))
	end
end

local util = require("jit.util")
local function to_console_string(value)
	local kind = type(value)
	local str
	if kind == "string" then
		if string.find(value, "%c") then
			str = string.gsub(string.format("%q", value), "%c", ctlsub)
		else
			str = value
		end
	elseif kind == "table" then
		local mt = getmetatable(value)
		local class = rawget(value, "___is_class_metatable___") and "class"
			or (mt and mt ~= true and mt.___is_class_metatable___ and table.find(_G, mt) or "table")
		str = string.format("%s {…}: %p ", class, value)
	elseif kind == "function" then
		str = string.format("ƒ (): %p", value)
	elseif kind == "userdata" then
		if string.format("%p", value) == "0x00004004" then
			str = "sentinel"
		else
			str = tostring(value)
		end
	else
		str = string.format("%s", value)
	end
	return str
end
rawset(_G, "to_console_string", to_console_string)

local function resolve_path(value, path)
	for i=1, #path do
		local part = path[i]
		if part == -1 then -- Special pseudo-path.
			value = getmetatable(value)
			goto continue
		end
		local kind = type(value)
		if kind == "function" then
			value = util.funcinfo(value)
		elseif kind ~= "table" then
			return nil
		end
		for _, v in pairs(value) do
			if part == 0 then
				value = v
				goto continue
			end
			part = part - 1
		end
		::continue::
	end
	return value
end

local ffi = require("ffi")
local function table_size(t)
	local addr = string.match(string.format("%p", t), "0x(%x+)")
	assert(addr, "invalid pointer")
	local ptr = ffi.cast("uint32_t*", tonumber(addr, 16))
	return ptr[6], ptr[7]
end

local function format_value(value, name, include_children, is_nested)
	local kind = type(value)
	local children
	local metatable
	if include_children then
		if kind == "table" or kind == "function" then
			children = {}
			local iterationValue = value
			if kind == "function" then
				iterationValue = util.funcinfo(value)
				if iterationValue.addr then
					iterationValue.addr = string.format("%016x", iterationValue.addr)
				end
			end
			for k, v in pairs(iterationValue) do
				children[#children+1] = format_value(v, k)
			end
			if kind == "table" then
				local mt = getmetatable(value)
				if mt ~= nil then
					children[#children+1] = format_value(mt, '(metatable)')
				end
				local asize, hsize = table_size(value)
				children[#children+1] = format_value(asize, '(size array)')
				children[#children+1] = format_value(hsize, '(size hash)')
			end
		end
	end
	local value_str
	if not is_nested and kind == "string" then
		value_str = string.gsub(string.format("%q", value), "\\9%f[%D]", "\t")
	end
	return {
		name = to_console_string(name),
		value = value_str or to_console_string(value),
		type = kind,
		children = children, metatable = metatable,
	}
end

local function make_environment(level)
	level = level + 1
	return setmetatable({}, {
		__index = function(_, target_name)
			local found, target_value = false
			for i=1, 9999 do -- (1) Locals.
				local name, value = debug.getlocal(level, i)
				if not name then break end
				-- Need to keep the last match in case there is name shadowing.
				if name == target_name then
					found = true
					target_value = value
				end
			end
			if found then
				return target_value
			end
			local func = debug.getinfo(level, "f").func
			for i=1, 9999 do -- (2) Upvalues.
				local name, value = debug.getupvalue(func, i)
				if not name then break end
				if name == target_name then
					return value
				end
			end
			return rawget(_G, target_name) -- (3) Globals.
		end,
		__newindex = function(_, target_name, target_value)
			local found, target_i = false
			for i=1, 9999 do -- (1) Locals.
				local name = debug.getlocal(level, i)
				if not name then break end
				-- Need to keep the last match in case there is name shadowing.
				if name == target_name then
					found = true
					target_i = i
				end
			end
			if found then
				debug.setlocal(level, target_i, target_value)
			end
			local func = debug.getinfo(level, "f").func
			for i=1, 9999 do -- (2) Upvalues.
				local name, value = debug.getupvalue(func, i)
				if not name then break end
				if name == target_name then
					debug.setupvalue(func, i, target_value)
					return
				end
			end
			rawset(_G, target_name, target_value) -- (3) Globals.
		end,
	})
end

--JSON decode
local parse

local function create_set(...) 
  local res = {}
  for i = 1, select("#", ...) do
    res[ select(i, ...) ] = true
  end
  return res
end

local space_chars   = create_set(" ", "\t", "\r", "\n")
local delim_chars   = create_set(" ", "\t", "\r", "\n", "]", "}", ",")
local escape_chars  = create_set("\\", "/", '"', "b", "f", "n", "r", "t", "u")
local literals      = create_set("true", "false", "null")

local literal_map = {
  [ "true"  ] = true,
  [ "false" ] = false,
  [ "null"  ] = nil,
}


local function next_char(str, idx, set, negate)
  for i = idx, #str do
    if set[str:sub(i, i)] ~= negate then
      return i
    end
  end
  return #str + 1
end


local function decode_error(str, idx, msg)
  local line_count = 1
  local col_count = 1
  for i = 1, idx - 1 do
    col_count = col_count + 1
    if str:sub(i, i) == "\n" then
      line_count = line_count + 1
      col_count = 1
    end
  end
  error( string.format("%s at line %d col %d", msg, line_count, col_count) )
end


local function codepoint_to_utf8(n)
  -- http://scripts.sil.org/cms/scripts/page.php?site_id=nrsi&id=iws-appendixa
  local f = math.floor
  if n <= 0x7f then
    return string.char(n)
  elseif n <= 0x7ff then
    return string.char(f(n / 64) + 192, n % 64 + 128)
  elseif n <= 0xffff then
    return string.char(f(n / 4096) + 224, f(n % 4096 / 64) + 128, n % 64 + 128)
  elseif n <= 0x10ffff then
    return string.char(f(n / 262144) + 240, f(n % 262144 / 4096) + 128,
                       f(n % 4096 / 64) + 128, n % 64 + 128)
  end
  error( string.format("invalid unicode codepoint '%x'", n) )
end


local function parse_unicode_escape(s)
  local n1 = tonumber( s:sub(3, 6),  16 )
  local n2 = tonumber( s:sub(9, 12), 16 )
  -- Surrogate pair?
  if n2 then
    return codepoint_to_utf8((n1 - 0xd800) * 0x400 + (n2 - 0xdc00) + 0x10000)
  else
    return codepoint_to_utf8(n1)
  end
end


local function parse_string(str, i)
  local has_unicode_escape = false
  local has_surrogate_escape = false
  local has_escape = false
  local last
  for j = i + 1, #str do
    local x = str:byte(j)

    if x < 32 then
      decode_error(str, j, "control character in string")
    end

    if last == 92 then -- "\\" (escape char)
      if x == 117 then -- "u" (unicode escape sequence)
        local hex = str:sub(j + 1, j + 5)
        if not hex:find("%x%x%x%x") then
          decode_error(str, j, "invalid unicode escape in string")
        end
        if hex:find("^[dD][89aAbB]") then
          has_surrogate_escape = true
        else
          has_unicode_escape = true
        end
      else
        local c = string.char(x)
        if not escape_chars[c] then
          decode_error(str, j, "invalid escape char '" .. c .. "' in string")
        end
        has_escape = true
      end
      last = nil

    elseif x == 34 then -- '"' (end of string)
      local s = str:sub(i + 1, j - 1)
      if has_surrogate_escape then 
        s = s:gsub("\\u[dD][89aAbB]..\\u....", parse_unicode_escape)
      end
      if has_unicode_escape then 
        s = s:gsub("\\u....", parse_unicode_escape)
      end
      if has_escape then
        s = s:gsub("\\.", escape_char_map_inv)
      end
      return s, j + 1
    
    else
      last = x
    end
  end
  decode_error(str, i, "expected closing quote for string")
end


local function parse_number(str, i)
  local x = next_char(str, i, delim_chars)
  local s = str:sub(i, x - 1)
  local n = tonumber(s)
  if not n then
    decode_error(str, i, "invalid number '" .. s .. "'")
  end
  return n, x
end


local function parse_literal(str, i)
  local x = next_char(str, i, delim_chars)
  local word = str:sub(i, x - 1)
  if not literals[word] then
    decode_error(str, i, "invalid literal '" .. word .. "'")
  end
  return literal_map[word], x
end


local function parse_array(str, i)
  local res = {}
  local n = 1
  i = i + 1
  while 1 do
    local x
    i = next_char(str, i, space_chars, true)
    -- Empty / end of array?
    if str:sub(i, i) == "]" then 
      i = i + 1
      break
    end
    -- Read token
    x, i = parse(str, i)
    res[n] = x
    n = n + 1
    -- Next token 
    i = next_char(str, i, space_chars, true)
    local chr = str:sub(i, i)
    i = i + 1
    if chr == "]" then break end
    if chr ~= "," then decode_error(str, i, "expected ']' or ','") end
  end
  return res, i
end


local function parse_object(str, i)
  local res = {}
  i = i + 1
  while 1 do
    local key, val
    i = next_char(str, i, space_chars, true)
    -- Empty / end of object?
    if str:sub(i, i) == "}" then 
      i = i + 1
      break
    end
    -- Read key
    if str:sub(i, i) ~= '"' then
      decode_error(str, i, "expected string for key")
    end
    key, i = parse(str, i)
    -- Read ':' delimiter
    i = next_char(str, i, space_chars, true)
    if str:sub(i, i) ~= ":" then
      decode_error(str, i, "expected ':' after key")
    end
    i = next_char(str, i + 1, space_chars, true)
    -- Read value
    val, i = parse(str, i)
    -- Set
    res[key] = val
    -- Next token
    i = next_char(str, i, space_chars, true)
    local chr = str:sub(i, i)
    i = i + 1
    if chr == "}" then break end
    if chr ~= "," then decode_error(str, i, "expected '}' or ','") end
  end
  return res, i
end


local char_func_map = {
  [ '"' ] = parse_string,
  [ "0" ] = parse_number,
  [ "1" ] = parse_number,
  [ "2" ] = parse_number,
  [ "3" ] = parse_number,
  [ "4" ] = parse_number,
  [ "5" ] = parse_number,
  [ "6" ] = parse_number,
  [ "7" ] = parse_number,
  [ "8" ] = parse_number,
  [ "9" ] = parse_number,
  [ "-" ] = parse_number,
  [ "t" ] = parse_literal,
  [ "f" ] = parse_literal,
  [ "n" ] = parse_literal,
  [ "[" ] = parse_array,
  [ "{" ] = parse_object,
}


parse = function(str, idx)
  local chr = str:sub(idx, idx)
  local f = char_func_map[chr]
  if f then
    return f(str, idx)
  end
  decode_error(str, idx, "unexpected character '" .. chr .. "'")
end


local function decode(str)
  if type(str) ~= "string" then
    error("expected argument of type string, got " .. type(str))
  end
  return ( parse(str, next_char(str, 1, space_chars, true)) )
end
--/JSON decode

local EVAL_REGISTRY = {}

local handlers = {
	stack = function(request)
		local response = {}
		for i=1, 9999 do
			local info = debug.getinfo(1+i, "nSl")
			if not info then break end
			response[i] = info
		end
		return response
	end,
	locals = function(request)
		local response = {}
		local level = request.level
		for i=1, 1000000000 do
			local name, value = debug.getlocal(level, i)
			if not name then break end
			response[i] = format_value(value, name)
		end
		return response
	end,
	upvals = function(request)
		local func = debug.getinfo(request.level, "f").func
		local response = {}
		for i=1, 1000000000 do
			local name, value = debug.getupvalue(func, i)
			if not name then break end
			response[i] = format_value(value, name)
		end
		return response
	end,
	contents = function(request)
		local _, value
		local id = request.id
		if id > 0 then
			_, value = debug.getlocal(request.level, id)
		else
			_, value = debug.getupvalue(request.level, -id)
		end
		return format_value(resolve_path(value, request.path))
	end,
	eval = function(request)
		-- If a stack level is provided, we have to adjust it skipping all the
		-- debug stuff that is currently on the stack. This is *very* brittle.
		local id = #EVAL_REGISTRY+1
		local eval_name = string.format("eval#%d", id)
		local thunk = loadstring("return ("..request.expression..")", eval_name)
		if not thunk then
			thunk = assert(loadstring(request.expression, eval_name))
		end
		local environment = request.level and make_environment(request.level + (3+2)) or _G
		setfenv(thunk, environment)
		local result = thunk()
		local completion = request.completion
		local response = format_value(result, eval_name, completion)
		if not completion then
			EVAL_REGISTRY[id] = result
			response.id = id
		end
		return response
	end,
	expandEval = function(request)
		return format_value(resolve_path(EVAL_REGISTRY[request.id], request.path), nil, true, true)
	end,
}

local function VSCodeDebugAdapter(str)
	local request = decode(str)
	local ok, result = pcall(handlers[request.request_type], request)
	stingray.Application.console_send({
		type = "vscode_debug_adapter",
		request_id = request.request_id,
		request_type = request.request_type,
		result = result,
		ok = ok,
	})
end

rawset(_G, "VSCodeDebugAdapter", VSCodeDebugAdapter)

stingray.Application.console_send({
	type = "vscode_debug_adapter",
	request_id = "inject",
	request_type = "inject",
	result = true,
	ok = true,
})
