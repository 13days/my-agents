# Run manually with CLAUDE_CLI set to an installed Claude Code.
# Uses an isolated config/workspace and a local mock model; no subscription calls.
import os,json,tempfile,subprocess,threading,http.server,socketserver,pty,fcntl,termios,struct,time,select,glob,socket,uuid
root=tempfile.mkdtemp(prefix='my-agents-native-roundtrip-');work=root+'/work';config=root+'/config';os.makedirs(work);os.makedirs(config);work=os.path.realpath(work)
requests=[]
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_POST(self):
  body=json.loads(self.rfile.read(int(self.headers.get('Content-Length','0'))) or b'{}')
  if self.path.startswith('/v1/messages/count_tokens'):out={'input_tokens':10}
  else:
   requests.append(body);out={'id':'msg_test_'+str(len(requests)),'type':'message','role':'assistant','model':'claude-sonnet-4-6','content':[{'type':'text','text':'LOCAL_TEST_REPLY_'+str(len(requests))}],'stop_reason':'end_turn','stop_sequence':None,'usage':{'input_tokens':10,'output_tokens':5}}
  if body.get('stream') and 'content' in out:
   text=out['content'][0]['text'];start={**out,'content':[],'stop_reason':None}
   events=[('message_start',{'type':'message_start','message':start}),('content_block_start',{'type':'content_block_start','index':0,'content_block':{'type':'text','text':''}}),('content_block_delta',{'type':'content_block_delta','index':0,'delta':{'type':'text_delta','text':text}}),('content_block_stop',{'type':'content_block_stop','index':0}),('message_delta',{'type':'message_delta','delta':{'stop_reason':'end_turn','stop_sequence':None},'usage':{'output_tokens':5}}),('message_stop',{'type':'message_stop'})]
   data=''.join('event: '+event+'\ndata: '+json.dumps(value)+'\n\n' for event,value in events).encode();content_type='text/event-stream'
  else:data=json.dumps(out).encode();content_type='application/json'
  self.send_response(200);self.send_header('Content-Type',content_type);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
server=socketserver.ThreadingTCPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
json.dump({'hasCompletedOnboarding':True,'bypassPermissionsModeAccepted':True,'lastOnboardingVersion':'2.1.319','theme':'dark','projects':{work:{'hasTrustDialogAccepted':True}}},open(config+'/.claude.json','w'))
env={**os.environ,'CLAUDE_CONFIG_DIR':config,'ANTHROPIC_BASE_URL':'http://127.0.0.1:'+str(server.server_address[1]),'ANTHROPIC_AUTH_TOKEN':'local-test-only','CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC':'1','DISABLE_AUTOUPDATER':'1','IS_SANDBOX':'1','TERM':'xterm-256color'}
for key in ['ANTHROPIC_API_KEY','CLAUDE_CODE_OAUTH_TOKEN','CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY']:env.pop(key,None)
master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',40,140,0,0))
json.dump({'permissions':{'defaultMode':'bypassPermissions'}},open(config+'/settings.json','w'))
sid=str(uuid.uuid4());p=subprocess.Popen([os.environ.get('CLAUDE_CLI','claude'),'--dangerously-skip-permissions','--session-id',sid,'--model','claude-sonnet-4-6'],cwd=work,env=env,stdin=slave,stdout=slave,stderr=slave,start_new_session=True);os.close(slave)
output=bytearray();answered=False;bypassAnswered=False;autoAnswered=False
def tick():
 global answered,bypassAnswered,autoAnswered
 if select.select([master],[],[],0.15)[0]:
  try:output.extend(os.read(master,65536))
  except OSError:pass
 if not answered and b'Do you want to use this API key?' in output:
  os.write(master,b'\x1b[A');time.sleep(.3);os.write(master,b'\r');answered=True
 if not bypassAnswered and b'BypassPermissions' in output:
  os.write(master,b'\x1b[B');time.sleep(.3);os.write(master,b'\r');bypassAnswered=True
 if not autoAnswered and b'Make' in output and b'keep' in output:
  os.write(master,b'\x1b[B');time.sleep(.3);os.write(master,b'\r');autoAnswered=True
 if output:open(root+'/terminal-output.bin','wb').write(output)
 time.sleep(.1)
def wait(fn,seconds=20):
 end=time.monotonic()+seconds
 while time.monotonic()<end:
  tick()
  if fn():return True
 return False
try:
 wait(lambda:len(glob.glob(config+'/sessions/*.json'))>0,8)
 for _ in range(15):tick()
 os.write(master,b'LOCAL_TEST_TERMINAL_ONE');tick();os.write(master,b'\r');wait(lambda:len(requests)>=1,12)
 files=glob.glob(config+'/sessions/*.json');record=None
 for f in files:
  d=json.load(open(f))
  if d.get('sessionId')==sid:record=d;break
 if not record:raise RuntimeError('native registry not created')
 print(json.dumps({'root':root,'requests':len(requests),'registryKeys':list(record),'status':record.get('status')}),flush=True)
 if not requests:raise RuntimeError('first terminal query not submitted')
 wait(lambda:b'LOCAL_TEST_REPLY_1' in output,5)
 s=socket.socket(socket.AF_UNIX);s.settimeout(3);s.connect(record['messagingSocketPath'])
 for f in glob.glob(config+'/sessions/'+str(record['pid'])+'*.key'):
  k=json.load(open(f))
  if k.get('procStart')==record.get('procStart') and k.get('peerToken'):s.sendall((json.dumps({'type':'auth','token':k['peerToken']})+'\n').encode());break
 s.sendall((json.dumps({'type':'user','message':{'role':'user','content':'LOCAL_TEST_EXTERNAL_TWO'}})+'\n').encode());s.close()
 if not wait(lambda:all(word in output for word in [b'Held',b'preview:',b'LOCAL_TEST_EXTERNAL_TWO']),8):raise RuntimeError('expected the native confirmation gate before opt-in')
 subprocess.check_call(['node','-e',"require(process.argv[1]).createNativeInboxPolicy({home:process.argv[2],stateDir:process.argv[3]}).set(true)",os.path.abspath('core/native-inbox-policy.js'),config,root+'/panel'])
 print('enabled live auto-accept after observing held message',flush=True)
 if not wait(lambda:len(requests)>=2,15):raise RuntimeError('live opt-in did not release held message')
 wait(lambda:b'LOCAL_TEST_REPLY_2' in output,5)
 for _ in range(8):tick()
 os.write(master,b'LOCAL_TEST_TERMINAL_THREE');tick();os.write(master,b'\r')
 if not wait(lambda:len(requests)>=3,12):raise RuntimeError('third terminal query not submitted')
 payload=json.dumps(requests[2]);assert 'LOCAL_TEST_TERMINAL_ONE' in payload and 'LOCAL_TEST_EXTERNAL_TWO' in payload and 'LOCAL_TEST_TERMINAL_THREE' in payload
 print(json.dumps({'roundtrip':True,'samePid':p.poll() is None,'requests':len(requests),'externalReplyVisible':b'LOCAL_TEST_REPLY_2' in output}),flush=True)
finally:
 open(root+'/terminal-output.bin','wb').write(output);json.dump(requests,open(root+'/requests.json','w'))
 p.terminate()
 try:p.wait(timeout=4)
 except subprocess.TimeoutExpired:p.kill()
 os.close(master);server.shutdown();print('artifacts',root,flush=True)
